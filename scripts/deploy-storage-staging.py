#!/usr/bin/env python3
"""Cut over a drained private studio to fresh PostgreSQL/S3 storage, or export it back.

All source data and financial records are retained. Credentials are read on the host.
The application must already be an immutable release from origin/main.
"""
import argparse
import configparser
import datetime
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time
import urllib.request
from urllib.parse import urlsplit, urlunsplit, unquote
import uuid
import xmlrpc.client

spec=importlib.util.spec_from_file_location("storage_runtime",Path(__file__).with_name("storage-runtime-launch.py"))
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
BASE=["rough-cut-staging-edge","rough-cut-staging-api","rough-cut-staging-worker","rough-cut-staging-sweeper"]
EXTRA=["rough-cut-staging-worker-2","rough-cut-staging-worker-3","rough-cut-staging-backup"]
CONFIG_FILES=["active-release.txt","run-api.sh","run-worker.sh","run-sweeper.sh","run-backup.sh","runtime-config.sh","storage-deployment.json","storage-json-current.json"]

def private_text(path,text):
    pending=path.with_name(path.name+"."+uuid.uuid4().hex+".pending")
    descriptor=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(descriptor,"w") as file:file.write(text);file.flush();os.fsync(file.fileno())
        os.replace(pending,path)
        descriptor=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(descriptor)
        finally:os.close(descriptor)
    finally:pending.unlink(missing_ok=True)

def env_file(path):
    runtime.regular(path,True);values={}
    for line in path.read_text().splitlines():
        if not line.strip() or line.startswith("#"):continue
        key,value=line.removeprefix("export ").split("=",1);parts=shlex.split(value)
        if len(parts)!=1:raise RuntimeError("invalid private environment file")
        values[key]=parts[0]
    return values

def save_env(path,values):private_text(path,"".join(key+"="+shlex.quote(value)+"\n" for key,value in sorted(values.items())))

def identities(database,bucket):
    if not re.fullmatch(r"hollywood_video_staging(?:_[a-z0-9_]{1,32})?",database):raise RuntimeError("use a dedicated staging database name")
    if not re.fullmatch(r"rough-cut-staging(?:-[a-z0-9-]{1,32})?",bucket):raise RuntimeError("use a dedicated staging bucket name")

def current_json(root):
    marker=root/"storage-json-current.json"
    if marker.exists():
        runtime.regular(marker,True);value=json.loads(marker.read_text())
        if value.get("schema")!="hv-json-deployment/1":raise RuntimeError("unknown JSON deployment")
        source,media=Path(value["stateRoot"]).resolve(strict=True),Path(value["artifactRoot"]).resolve(strict=True)
    else:source,media=root/"data",root/"data/artifacts"
    if not source.is_relative_to(root) or not media.is_relative_to(root):raise RuntimeError("JSON storage escaped the runtime")
    return source,media

def application(root,repo):
    # Fail before creating a destination or closing admission if the pinned runtime is not self-contained.
    runtime.regular(root/"bin/bun")
    runtime.regular(root/"active-release.txt");app=Path((root/"active-release.txt").read_text().strip()).resolve(strict=True)
    if not app.is_relative_to(root/"releases"):raise RuntimeError("storage deployment requires an immutable release")
    sha=(app/".deployed-sha").read_text().strip()
    if not re.fullmatch(r"[a-f0-9]{40}",sha):raise RuntimeError("invalid release commit")
    result=subprocess.run(["git","-C",str(repo),"merge-base","--is-ancestor",sha,"origin/main"],capture_output=True)
    if result.returncode:raise RuntimeError("release must be on origin/main")
    for name in ("storage-runtime-launch.py","storage-readiness.ts","storage-backup-service.ts","deploy-storage-staging.py"):
        runtime.regular(app/"scripts"/name)
    return app,sha

def process_states():
    client=xmlrpc.client.ServerProxy("http://127.0.0.1:29011/RPC2")
    return {item["name"]:item["statename"] for item in client.supervisor.getAllProcessInfo()}

def control(action,names):
    for name in names:
        state=process_states().get(name)
        if state is None:continue
        if action=="stop" and state in ("STOPPED","EXITED","FATAL"):continue
        if action=="start" and state in ("RUNNING","STARTING"):continue
        result=subprocess.run(["supervisorctl","-c",str(runtime.CONFIG),action,name],capture_output=True,timeout=1200)
        if result.returncode:raise RuntimeError("managed service action failed: "+action+" "+name)

def execute(root,app,arguments,environment,log,timeout=1200):
    with log.open("ab") as output:
        result=subprocess.run([str(root/"bin/bun"),*arguments],cwd=app,env=environment,stdout=output,stderr=output,timeout=timeout)
    if result.returncode:raise RuntimeError("storage operation failed; inspect private "+log.name)

def capture(root,app,arguments,environment):
    result=subprocess.run([str(root/"bin/bun"),*arguments],cwd=app,env=environment,capture_output=True,text=True,timeout=30)
    if result.returncode:raise RuntimeError("storage state validation failed")
    return json.loads(result.stdout.splitlines()[-1])

def postgres_environment(values,database):
    url=urlsplit(values["HV_PG_ADMIN_URL"]);tls=Path(values["HV_DATABASE_TLS_DIR"])
    if url.hostname!="127.0.0.1" or url.port!=55432 or url.username!="hv_admin":raise RuntimeError("unexpected managed database endpoint")
    return {"PATH":"/usr/bin:/bin","PGHOST":url.hostname,"PGPORT":str(url.port),"PGUSER":"hv_admin","PGDATABASE":database,
        "PGPASSWORD":unquote(url.password or ""),"PGSSLMODE":"verify-full","PGSSLROOTCERT":str(tls/"ca.pem"),
        "PGSSLCERT":str(tls/"hv_admin.pem"),"PGSSLKEY":str(tls/"hv_admin-key.pem"),"PGCONNECT_TIMEOUT":"10",
        "LD_LIBRARY_PATH":values["HV_PG_LIB"]}

def sql(platform,values,database,statement):
    result=subprocess.run([str(platform/"postgres-dist/usr/lib/postgresql/15/bin/psql"),"-XAt","-v","ON_ERROR_STOP=1"],
        input=statement,text=True,capture_output=True,env=postgres_environment(values,database),timeout=60)
    if result.returncode:raise RuntimeError("managed database operation failed")
    return result.stdout.strip()

def drain(root,app,environment,postgres=False):
    control("stop",BASE[:2])
    deadline=time.monotonic()+1800
    while time.monotonic()<deadline:
        if postgres:
            platform=Path(json.loads((root/"storage-deployment.json").read_text())["platformRoot"])
            database=urlsplit(environment["HV_PG_ADMIN_URL"]).path[1:]
            active=int(sql(platform,environment,database,"SELECT count(*) FROM hv_jobs WHERE status IN ('queued','running');"))
        else:
            source,_=current_json(root);jobs=json.loads((source/"queue/jobs.json").read_text())
            active=sum(job["status"] in ("queued","running") for job in jobs)
        if not active:break
        time.sleep(1)
    else:raise RuntimeError("jobs did not drain; admission remains closed")
    control("stop",BASE[2:]+EXTRA)

def health():
    deadline=time.monotonic()+900
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8081/health",timeout=3) as response:
                if response.status==200:return
        except (OSError,TimeoutError):pass
        time.sleep(1)
    raise RuntimeError("private studio did not pass its health check")

def common(source,media):
    values={"HV_PROVIDER_PRIMARY":"mock","HV_PROVIDER_SECONDARY":"mock","HV_ANIMATIC_PROVIDER":"mock","HV_NARRATION":"1",
        "HV_ANIMATIC_CAPTIONS":"0","HV_MONTHLY_BUDGET_USD":"500","HV_ANIMATIC_COST_CAP_USD":"5","HV_COST_CAP_PER_SHOT_USD":"5",
        "HV_PROVIDER_TIMEOUT_MS":"180000","HV_STORAGE":"json","HV_ARTIFACT_STORAGE":"local","HV_QUEUE_PATH":str(source/"queue/jobs.json"),
        "HV_PROJECT_STATE_PATH":str(source/"state/projects.json"),"HV_COST_LEDGER_PATH":str(source/"state/cost-ledger.json"),
        "HV_REVIEW_QUEUE_PATH":str(source/"state/operator-review-queue.json"),"HV_ARTIFACT_ROOT":str(media)}
    return "#!/usr/bin/env bash\n"+"".join("export "+key+"="+shlex.quote(value)+"\n" for key,value in values.items())

def wrappers(root):
    prefix='#!/usr/bin/env bash\nset -euo pipefail\nR="$(cd "$(dirname "$0")" && pwd)"\n'
    for role,target in {"api":"packages/api/src/server.ts","worker":"packages/queue/src/worker.ts","sweeper":"scripts/sweep-expired.ts","backup":""}.items():
        text=prefix
        if role in ("api","worker"):text+='set -a; source "$R/secrets.env"; set +a\n'
        text+='source "$R/runtime-config.sh"\n'
        if role=="api":
            text+='export PORT=8443\nexport HV_FRONTEND_ORIGIN="${HV_FRONTEND_ORIGIN:-http://localhost:8081}"\nexport HV_TRUST_PROXY=1\n'
            text+='export HV_TLS_CERT_PATH="$R/mtls/api/api.crt"\nexport HV_TLS_KEY_PATH="$R/mtls/api/api.key"\nexport HV_TLS_CLIENT_CA_PATH="$R/mtls/api/ca.crt"\n'
        text+='A="$(cat "$R/active-release.txt")"\nif [ -f "$R/storage-deployment.json" ]; then\n'
        text+='  exec python3 "$A/scripts/storage-runtime-launch.py" --runtime "$R" --role '+role+(' --slot "${1:-1}"' if role=="worker" else '')+'\nfi\n'
        if role=="backup":text+='echo "backup service requires an active storage deployment" >&2\nexit 1\n'
        else:text+='cd "$A"\nexec "$R/bin/bun" '+target+'\n'
        private_text(root/("run-"+role+".sh"),text)

def remove_extras(root):
    current=runtime.CONFIG.read_text();parsed=configparser.ConfigParser(interpolation=None);parsed.read_string(current);replacement=current
    for name in EXTRA:
        section="program:"+name
        if not parsed.has_section(section):continue
        script,arg,_=runtime.PROGRAMS[name]
        if parsed.get(section,"command")!="bash "+str(root/script)+arg:raise RuntimeError("extra service command changed")
        replacement=re.sub(r"(?ms)^\["+re.escape(section)+r"\]\n.*?(?=^\[|\Z)","",replacement)
    if replacement!=current:runtime.atomic_configuration(current,replacement)
    runtime.supervisor("reread");runtime.supervisor("update",*EXTRA)

def operation(root,name):
    directory=root/"storage-operations"/(datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")+"-"+name+"-"+uuid.uuid4().hex[:8])
    directory.mkdir(parents=True,mode=0o700)
    for item in CONFIG_FILES:
        if (root/item).exists():shutil.copy2(root/item,directory/item)
    return directory

def phase(directory,value):
    runtime.private_json(directory/"status.json",value)
    print(json.dumps({key:item for key,item in value.items() if key in ("phase","database","bucket","summary","snapshot","backend")}),flush=True)

def provision(root,platform,database,bucket,directory):
    identities(database,bucket)
    values=env_file(platform/"database.env")
    objects={key:value for key,value in env_file(platform/"object.env").items() if key in runtime.S3_KEYS}
    objects["HV_S3_BUCKET"]=bucket
    values.update({"HV_PG_BIN":str(platform/"postgres-dist/usr/lib/postgresql/15/bin"),"HV_PG_LIB":str(platform/"postgres-dist/usr/lib/x86_64-linux-gnu")})
    if sql(platform,values,"hollywood_video","SELECT count(*) FROM pg_database WHERE datname='"+database+"';")!="0":
        raise RuntimeError("cutover requires a fresh destination database")
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError
    client=boto3.client("s3",endpoint_url=objects["HV_S3_ENDPOINT"],region_name=objects["HV_S3_REGION"],
        aws_access_key_id=objects["HV_S3_ACCESS_KEY_ID"],aws_secret_access_key=objects["HV_S3_SECRET_ACCESS_KEY"],
        verify=objects["HV_STORAGE_CA_PATH"],config=Config(signature_version="s3v4",s3={"addressing_style":"path"},connect_timeout=3,read_timeout=10))
    try:client.head_bucket(Bucket=bucket)
    except ClientError as error:
        if error.response["ResponseMetadata"]["HTTPStatusCode"]!=404:raise RuntimeError("destination bucket availability could not be verified") from None
    else:raise RuntimeError("cutover requires a fresh destination bucket")
    sql(platform,values,"hollywood_video",'CREATE DATABASE "'+database+'" OWNER hv_admin;')
    client.create_bucket(Bucket=bucket)
    settings={"BlockPublicAcls":True,"IgnorePublicAcls":True,"BlockPublicPolicy":True,"RestrictPublicBuckets":True}
    client.put_public_access_block(Bucket=bucket,PublicAccessBlockConfiguration=settings)
    if client.get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"]!=settings:raise RuntimeError("private bucket configuration did not persist")
    for role,key in runtime.ROLES.items():
        original=urlsplit(values[key]);connection=urlunsplit(original._replace(path="/"+database))
        selected={key:connection,"HV_DATABASE_TLS_DIR":values["HV_DATABASE_TLS_DIR"],**objects}
        if role=="backup":selected.update({key:values[key] for key in ("HV_PG_BIN","HV_PG_LIB")})
        save_env(directory/("storage-"+role+".env"),selected)
    return {"PATH":"/usr/local/bin:/usr/bin:/bin",**env_file(directory/"storage-backup.env")}

def cutover(root,repo,platform,database,bucket):
    if (root/"storage-deployment.json").exists():raise RuntimeError("studio already uses managed PostgreSQL storage")
    app,sha=application(root,repo);source,media=current_json(root)
    directory=operation(root,"cutover");state={"phase":"preparing","database":database,"bucket":bucket,"releaseSha":sha}
    phase(directory,state)
    bootstrap_spec=importlib.util.spec_from_file_location("storage_bootstrap",app/"scripts/bootstrap-storage-platform.py")
    bootstrap=importlib.util.module_from_spec(bootstrap_spec);bootstrap_spec.loader.exec_module(bootstrap);bootstrap.bootstrap(platform)
    environment=provision(root,platform,database,bucket,directory)
    phase(directory,{**state,"phase":"destination-created"})
    activated=False
    try:
        drain(root,app,environment)
        summary=capture(root,app,["scripts/storage-snapshot.ts","--source",str(source)],environment);summary.pop("validated",None)
        saved=directory/"source";saved.mkdir(mode=0o700)
        for name in ("state","queue"):shutil.copytree(source/name,saved/name)
        phase(directory,{**state,"phase":"source-saved","summary":summary,"source":str(source),"media":str(media)})
        execute(root,app,["scripts/storage-snapshot.ts","--source",str(saved),"--import","--monthly-cap","500"],environment,directory/"import-state.log")
        execute(root,app,["scripts/storage-media.ts","--import","--source",str(media)],environment,directory/"import-media.log")
        observed=capture(root,app,["scripts/storage-snapshot.ts","--export","--output",str(directory/"import-check")],environment)
        if any(observed.get(key)!=value for key,value in summary.items()):raise RuntimeError("migration summary changed")
        repository=platform/"backups"/database
        execute(root,app,["scripts/storage-backup.ts","--create","--repository",str(repository)],environment,directory/"backup.log")
        for role in runtime.ROLES:shutil.copy2(directory/("storage-"+role+".env"),root/("storage-"+role+".env"))
        wrappers(root);private_text(root/"runtime-config.sh",common(source,media))
        manifest={"schema":"hv-storage-deployment/1","backend":"postgres","workers":3,"database":database,"bucket":bucket,
            "releaseSha":sha,"platformRoot":str(platform),"backupRepository":str(repository)}
        runtime.private_json(root/"storage-deployment.json",manifest);activated=True
        phase(directory,{**state,"phase":"activated","summary":summary})
        control("start",[BASE[1],BASE[0],BASE[2],BASE[3]])
        health()
        phase(directory,{**state,"phase":"healthy","backend":"postgres","summary":summary,"operation":str(directory)})
    except BaseException:
        phase(directory,{**state,"phase":"failed-after-activation" if activated else "failed-before-activation"})
        if not activated:
            for name in CONFIG_FILES:
                if (directory/name).exists():shutil.copy2(directory/name,root/name)
            control("start",BASE)
        # After activation, new jobs may exist. Never restore an older JSON ledger.
        # Use the current-state rollback command; keep both destinations and logs.
        raise

def mutable_json_copy(snapshot,destination):
    # An hv-state/1 snapshot has fixed checksums. Keep it immutable and run the
    # JSON adapter against a separate working copy without snapshot.json.
    if destination.exists():raise RuntimeError("JSON working directory already exists")
    destination.mkdir(mode=0o700)
    for name in ("state","queue"):shutil.copytree(snapshot/name,destination/name)
    return destination

def rollback(root,repo):
    app,_=application(root,repo);manifest,_,_=runtime.deployment(root)
    environment=runtime.role_environment(root,"backup",manifest)
    directory=operation(root,"rollback");state={"phase":"preparing-rollback","database":manifest["database"],"bucket":manifest["bucket"]}
    phase(directory,state);activated=False
    try:
        drain(root,app,environment,True)
        destination=directory/"current-state";media=directory/"current-artifacts"
        execute(root,app,["scripts/storage-snapshot.ts","--export","--output",str(destination)],environment,directory/"export-state.log")
        execute(root,app,["scripts/storage-media.ts","--export","--output",str(media)],environment,directory/"export-media.log")
        summary=capture(root,app,["scripts/storage-snapshot.ts","--source",str(destination)],environment);summary.pop("validated",None)
        phase(directory,{**state,"phase":"current-state-exported","summary":summary})
        live=mutable_json_copy(destination,directory/"live-json")
        verified=capture(root,app,["scripts/storage-snapshot.ts","--source",str(live)],environment)
        if any(verified.get(key)!=value for key,value in summary.items()):raise RuntimeError("JSON working copy changed during rollback")
        remove_extras(root)
        private_text(root/"runtime-config.sh",common(live,media))
        runtime.private_json(root/"storage-json-current.json",{"schema":"hv-json-deployment/1","stateRoot":str(live),"artifactRoot":str(media)})
        # Final atomic switch only after current state and all media have exported.
        os.replace(root/"storage-deployment.json",directory/"deactivated-storage.json");activated=True
        (root/"storage-ready.json").unlink(missing_ok=True)
        control("start",BASE);health()
        phase(directory,{**state,"phase":"healthy","backend":"json","summary":summary,"operation":str(directory)})
    except BaseException:
        phase(directory,{**state,"phase":"rollback-failed-after-switch" if activated else "rollback-refused-before-switch"})
        if not activated:
            for name in CONFIG_FILES:
                if (directory/name).exists():shutil.copy2(directory/name,root/name)
            control("start",BASE)
        raise

def upgrade(root,repo,sha):
    # Preserve the active backend, current JSON pointer and all data paths.
    app,_=application(root,repo)
    marker=root/"storage-deployment.json";postgres=marker.exists()
    manifest=runtime.deployment(root)[0] if postgres else None
    environment=runtime.role_environment(root,"backup",manifest) if postgres else {"PATH":"/usr/local/bin:/usr/bin:/bin"}
    module_spec=importlib.util.spec_from_file_location("release_files",Path(__file__).with_name("deploy-private-staging.py"))
    module=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(module)
    release,commit=module.prepare_release(root,repo,sha)
    directory=operation(root,"release-upgrade")
    state={"phase":"preparing-upgrade","backend":"postgres" if postgres else "json","releaseSha":commit}
    phase(directory,state)
    try:
        drain(root,app,environment,postgres)
        if postgres:
            execute(root,app,["scripts/storage-backup.ts","--create","--repository",manifest["backupRepository"]],environment,directory/"backup.log")
            execute(root,release,["scripts/migrate-storage.ts"],environment,directory/"migrations.log")
        else:
            source,_=current_json(root)
            capture(root,app,["scripts/storage-snapshot.ts","--source",str(source)],environment)
            saved=directory/"current-json";saved.mkdir(mode=0o700)
            for name in ("state","queue"):shutil.copytree(source/name,saved/name)
        private_text(root/"active-release.txt",str(release)+"\n")
        if manifest:runtime.private_json(marker,{**manifest,"releaseSha":commit})
        phase(directory,{**state,"phase":"release-selected"})
        control("start",[BASE[1],BASE[0],BASE[2],BASE[3]])
        health();phase(directory,{**state,"phase":"healthy"})
    except BaseException:
        # A schema migration or new admission may have happened. Keep current
        # storage authoritative; never substitute an older data snapshot.
        phase(directory,{**state,"phase":"upgrade-needs-recovery"});raise

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,required=True);parser.add_argument("--repo",type=Path,required=True)
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument("--rollback",action="store_true");mode.add_argument("--release-sha")
    parser.add_argument("--platform",type=Path)
    parser.add_argument("--database");parser.add_argument("--bucket")
    args=parser.parse_args();root=args.root.resolve(strict=True)
    runtime.regular(root/"secrets.env",True)
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+",str(root)):raise RuntimeError("unsupported runtime path")
    lock=os.open(root/"storage-deploy.lock",os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if args.release_sha:upgrade(root,args.repo.resolve(strict=True),args.release_sha)
        elif args.rollback:rollback(root,args.repo.resolve(strict=True))
        else:
            if not args.platform or not args.database or not args.bucket:parser.error("cutover requires --platform, --database and --bucket")
            cutover(root,args.repo.resolve(strict=True),args.platform.resolve(strict=True),args.database,args.bucket)
    finally:os.close(lock)

if __name__=="__main__":main()
