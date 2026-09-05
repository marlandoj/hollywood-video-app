#!/usr/bin/env python3
"""Start the managed PostgreSQL/S3 studio with a boot-specific readiness gate."""
import argparse
import configparser
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tempfile
import time
import uuid
from urllib.parse import urlsplit

CONFIG=Path("/etc/zo/supervisord-user.conf")
ROLES={"api":"HV_API_DATABASE_URL","worker":"HV_WORKER_DATABASE_URL","sweeper":"HV_WORKER_DATABASE_URL","backup":"HV_PG_ADMIN_URL"}
DB_KEYS=set(ROLES.values())
S3_KEYS={"HV_S3_ENDPOINT","HV_S3_BUCKET","HV_S3_REGION","HV_S3_ACCESS_KEY_ID","HV_S3_SECRET_ACCESS_KEY","NODE_EXTRA_CA_CERTS","HV_STORAGE_CA_PATH"}
PROGRAMS={
    "rough-cut-staging-worker":("run-worker.sh","",900),
    "rough-cut-staging-worker-2":("run-worker.sh"," 2",900),
    "rough-cut-staging-worker-3":("run-worker.sh"," 3",900),
    "rough-cut-staging-backup":("run-backup.sh","",600),
}

def regular(path, private=False):
    metadata=path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():raise RuntimeError("runtime file is not regular: "+path.name)
    if private and metadata.st_mode & 0o077:raise RuntimeError("runtime environment must be private: "+path.name)
    return metadata

def deployment(runtime):
    path=runtime/"storage-deployment.json";metadata=regular(path,True)
    if metadata.st_size>8192:raise RuntimeError("storage deployment manifest is too large")
    value=json.loads(path.read_text())
    if value.get("schema")!="hv-storage-deployment/1" or value.get("backend")!="postgres" or value.get("workers")!=3:
        raise RuntimeError("storage deployment manifest is not an active three-worker PostgreSQL deployment")
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}",value.get("database","")) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]",value.get("bucket","")):
        raise RuntimeError("invalid storage destination identity")
    if not re.fullmatch(r"[a-f0-9]{40}",value.get("releaseSha","")):raise RuntimeError("invalid storage release identity")
    platform=Path(value["platformRoot"]).resolve(strict=True)
    backup=Path(value["backupRepository"]).resolve()
    if not backup.is_relative_to(platform/"backups") or backup==platform/"backups":raise RuntimeError("backup repository escaped its storage runtime")
    regular(runtime/"active-release.txt")
    app=Path((runtime/"active-release.txt").read_text().strip()).resolve(strict=True)
    if not app.is_relative_to(runtime/"releases"):raise RuntimeError("active application is not an immutable runtime release")
    regular(app/".deployed-sha")
    if (app/".deployed-sha").read_text().strip()!=value["releaseSha"]:raise RuntimeError("storage configuration and application release disagree")
    for name in ("run-api.sh","run-worker.sh","run-sweeper.sh","run-backup.sh","bin/bun"):regular(runtime/name)
    return value,platform,app

def fingerprint(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(",",":")).encode()).hexdigest()
def boot_id():return Path("/proc/sys/kernel/random/boot_id").read_text().strip()

def ready(runtime,value,boot=None):
    path=runtime/"storage-ready.json"
    try:
        if regular(path).st_size>4096:return False
        saved=json.loads(path.read_text())
        return saved.get("schema")=="hv-storage-ready/1" and saved.get("bootId")== (boot or boot_id()) and saved.get("deploymentSha256")==fingerprint(value)
    except (OSError,ValueError,RuntimeError):return False

def private_json(path,value):
    temporary=path.with_name(path.name+"."+uuid.uuid4().hex+".pending")
    descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(descriptor,"w") as file:
            json.dump(value,file);file.flush();os.fsync(file.fileno())
        os.replace(temporary,path)
        descriptor=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(descriptor)
        finally:os.close(descriptor)
    finally:temporary.unlink(missing_ok=True)

def role_environment(runtime,role,value,inherited=None):
    inherited=dict(os.environ if inherited is None else inherited)
    # Do not pass Zo connector credentials or another database role to the app.
    env={key:item for key,item in inherited.items() if key in ("PATH","PORT","HOST","HOSTNAME") or (key.startswith("HV_") and key not in DB_KEYS)}
    for key in ("HV_TOKEN_SECRET","HV_OPERATOR_GRANT_SECRET"):
        if role!="api":env.pop(key,None)
    if role=="worker" and inherited.get("FAL_KEY"):env["FAL_KEY"]=inherited["FAL_KEY"]
    if role in ("sweeper","backup"):env={"PATH":inherited.get("PATH","/usr/local/bin:/usr/bin:/bin")}
    path=runtime/("storage-"+role+".env");regular(path,True)
    allowed=S3_KEYS|{ROLES[role],"HV_DATABASE_TLS_DIR"}|({"HV_PG_BIN","HV_PG_LIB"} if role=="backup" else set())
    values={}
    for line in path.read_text().splitlines():
        if not line.strip() or line.startswith("#"):continue
        key,text=line.split("=",1);parts=shlex.split(text)
        if key not in allowed or len(parts)!=1:raise RuntimeError("unexpected variable in role environment")
        values[key]=parts[0]
    required={ROLES[role],"HV_DATABASE_TLS_DIR","HV_S3_ENDPOINT","HV_S3_BUCKET","HV_S3_REGION","HV_S3_ACCESS_KEY_ID","HV_S3_SECRET_ACCESS_KEY"}
    if not required.issubset(values):raise RuntimeError("role environment is incomplete")
    if urlsplit(values["HV_S3_ENDPOINT"]).scheme!="https":raise RuntimeError("managed object storage requires HTTPS")
    connection=urlsplit(values.get(ROLES[role],""))
    expected={"api":"hv_api","worker":"hv_worker","sweeper":"hv_worker","backup":"hv_admin"}[role]
    if connection.scheme not in ("postgres","postgresql") or connection.username!=expected or connection.path!="/"+value["database"]:
        raise RuntimeError("database role environment does not match the deployment")
    if values.get("HV_S3_BUCKET")!=value["bucket"]:raise RuntimeError("object bucket does not match the deployment")
    env.update(values);env["HV_STORAGE"]="postgres";env["HV_ARTIFACT_STORAGE"]="s3"
    if role!="backup":env["HV_ARTIFACT_ROOT"]=str(runtime/"data/cache")
    return env

def managed_configuration(current,runtime):
    parsed=configparser.ConfigParser(interpolation=None);parsed.read_string(current)
    result=current;changed=[]
    for name,(script,argument,wait) in PROGRAMS.items():
        section="program:"+name;command="bash "+str(runtime/script)+argument
        updates={"stopsignal":"TERM","stopasgroup":"false","killasgroup":"true","stopwaitsecs":str(wait)}
        if parsed.has_section(section):
            if parsed.get(section,"command")!=command:raise RuntimeError("managed service name belongs to another command")
            if all(parsed.get(section,key,fallback=None)==item for key,item in updates.items()):continue
            pattern=r"(?ms)^\["+re.escape(section)+r"\]\n.*?(?=^\[|\Z)"
            match=re.search(pattern,result)
            if not match:raise RuntimeError("managed service section could not be located")
            block=match.group()
            for key,item in updates.items():
                setting=r"(?m)^"+key+r"\s*=.*$"
                block=re.sub(setting,key+"="+item,block) if re.search(setting,block) else block.rstrip()+"\n"+key+"="+item+"\n"
            result=result[:match.start()]+block+result[match.end():]
        else:
            result+=f"\n[{section}]\ncommand={command}\ndirectory={runtime}\nautostart=true\nautorestart=true\nstartsecs=2\n"
            result+="\n".join(key+"="+item for key,item in updates.items())+"\n"
            result+=f"stdout_logfile=/dev/shm/{name}.log\nstderr_logfile=/dev/shm/{name}_err.log\n"
        changed.append(name)
    return result,changed

def supervisor(action,*names):
    result=subprocess.run(["supervisorctl","-c",str(CONFIG),action,*names],capture_output=True,text=True,timeout=120)
    if result.returncode:raise RuntimeError("managed service action failed: "+action)
    return result.stdout

def atomic_configuration(current,replacement):
    metadata=CONFIG.stat();descriptor,name=tempfile.mkstemp(prefix=".storage-runtime-",dir=CONFIG.parent)
    try:
        os.fchmod(descriptor,stat.S_IMODE(metadata.st_mode));os.fchown(descriptor,metadata.st_uid,metadata.st_gid)
        with os.fdopen(descriptor,"w") as file:file.write(replacement);file.flush();os.fsync(file.fileno())
        if CONFIG.read_text()!=current:raise RuntimeError("supervisor configuration changed during bootstrap")
        os.replace(name,CONFIG)
        directory=os.open(CONFIG.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:Path(name).unlink(missing_ok=True)

def start(runtime):
    lock=os.open(runtime/"storage-startup.lock",os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX)
        value,platform,app=deployment(runtime)
        for role in ROLES:role_environment(runtime,role,value)
        current=CONFIG.read_text();replacement,changed=managed_configuration(current,runtime)
        if changed:atomic_configuration(current,replacement)
        supervisor("reread");supervisor("update",*PROGRAMS)
        for name in PROGRAMS:
            state=subprocess.run(["supervisorctl","-c",str(CONFIG),"status",name],capture_output=True,text=True,timeout=10).stdout.split()
            if not any(item in state for item in ("RUNNING","STARTING")):supervisor("start",name)
        module_spec=importlib.util.spec_from_file_location("storage_core",app/"scripts/bootstrap-storage-platform.py")
        module=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(module)
        module.bootstrap(platform)
        env=role_environment(runtime,"api",value)
        deadline=time.monotonic()+300
        while time.monotonic()<deadline:
            try:
                probe=subprocess.run([str(runtime/"bin/bun"),str(app/"scripts/storage-readiness.ts")],env=env,capture_output=True,text=True,timeout=20)
                if probe.returncode==0:break
            except subprocess.TimeoutExpired:pass
            time.sleep(1)
        else:raise RuntimeError("application storage did not pass authenticated readiness checks")
        if deployment(runtime)[0]!=value:raise RuntimeError("storage deployment changed during startup")
        private_json(runtime/"storage-ready.json",{"schema":"hv-storage-ready/1","bootId":boot_id(),"deploymentSha256":fingerprint(value),"readyAt":time.time()})
    finally:os.close(lock)

def wait(runtime):
    deadline=time.monotonic()+1200
    while time.monotonic()<deadline:
        value,_,_=deployment(runtime)
        if ready(runtime,value):return
        time.sleep(0.5)
    raise RuntimeError("managed storage startup did not release its readiness gate")

def launch(runtime,role,slot=1):
    runtime=runtime.resolve(strict=True)
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+",str(runtime)):raise RuntimeError("unsupported runtime path")
    if role=="api":start(runtime)
    else:wait(runtime)
    value,_,app=deployment(runtime);environment=role_environment(runtime,role,value)
    targets={"api":["packages/api/src/server.ts"],"worker":["packages/queue/src/worker.ts"],"sweeper":["scripts/sweep-expired.ts"],
             "backup":["scripts/storage-backup-service.ts","--repository",value["backupRepository"],"--interval-seconds","120"]}
    if role=="worker":environment["HV_WORKER_ID"]="zo-staging-worker-"+str(slot)
    os.chdir(app);binary=str(runtime/"bin/bun");os.execve(binary,[binary,*targets[role]],environment)

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime",type=Path,required=True);parser.add_argument("--role",choices=ROLES,required=True)
    parser.add_argument("--slot",type=int,choices=(1,2,3),default=1)
    args=parser.parse_args();launch(args.runtime,args.role,args.slot)
