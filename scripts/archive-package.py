#!/usr/bin/env python3
"""Pack or verify and unpack a portable Hollywood Video project archive."""
import argparse, hashlib, json, os, re, shutil, stat, uuid, zipfile
from pathlib import Path

SCHEMA = "hv-project-archive/1"
MAX_FILES = 100_000
MAX_FILE_BYTES = 8 * 1024**3
MAX_TOTAL_BYTES = 64 * 1024**3
MAX_MANIFEST_BYTES = 8 * 1024**2
MAX_STATE_FILE_BYTES = 256 * 1024**2
STATE_FILES = {"state/projects.json","state/cost-ledger.json","state/operator-review-queue.json","queue/jobs.json","snapshot.json"}
ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
def sync_directory(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)
def digest(path):
    with path.open("rb") as file: return hashlib.file_digest(file,"sha256").hexdigest()
def safe_path(name, project):
    if not isinstance(name,str) or len(name)>1024 or not re.fullmatch(r"[A-Za-z0-9_./-]+",name):
        raise ValueError("invalid archive path")
    parts=name.split("/")
    if any(part in ("",".","..")for part in parts): raise ValueError("archive traversal is forbidden")
    if name in STATE_FILES: return
    if len(parts)<4 or parts[0]!="artifacts" or parts[1]!=project or not ID.fullmatch(parts[2]):
        raise ValueError("archive contains another project or an unknown file")
def project_scope(root, project):
    if not ID.fullmatch(project): raise ValueError("invalid project id")
    state=json.loads((root/"state/projects.json").read_text())
    if state.get("version")!=1 or len(state.get("projects",[]))!=1 or state["projects"][0].get("id")!=project or state.get("takenDown"):
        raise ValueError("archive requires exactly one active project")
    if any(item.get("projectId")!=project for item in state.get("reviewLinks",[])):
        raise ValueError("archive review belongs to another project")
    jobs=json.loads((root/"queue/jobs.json").read_text())
    if any(job.get("projectId")!=project or job.get("status")not in ("done","failed","cancelled")for job in jobs):
        raise ValueError("archive requires drained jobs from one project")
    ledger=json.loads((root/"state/cost-ledger.json").read_text())
    if ledger.get("reservations") or any(event.get("projectId")!=project for event in ledger.get("events",[])):
        raise ValueError("archive billing belongs to another project or remains reserved")
    reviews=json.loads((root/"state/operator-review-queue.json").read_text())
    if not isinstance(reviews,list) or any(item.get("projectId")!=project for item in reviews):
        raise ValueError("archive operator review belongs to another project")
    if any(item.get("projectId")!=project for item in state.get("takedownLog",[])):
        raise ValueError("archive history belongs to another project")
    job_ids={job.get("id") for job in jobs}
    artifact_root=root/"artifacts"/project
    if artifact_root.exists() and any(child.name not in job_ids for child in artifact_root.iterdir()):
        raise ValueError("archive media belongs to an unknown job")
    return jobs
def pack(source, output, project):
    source, output = source.resolve(),output.resolve()
    if output.exists() or output.is_relative_to(source): raise ValueError("archive output must be new and outside the source")
    project_scope(source,project)
    files=[]; total=0
    for directory, folders, names in os.walk(source,followlinks=False):
        for folder in folders:
            if (Path(directory)/folder).is_symlink(): raise ValueError("symbolic links are forbidden")
        for name in names:
            path=Path(directory)/name
            if path.is_symlink() or not path.is_file(): raise ValueError("archive requires regular files")
            relative=path.relative_to(source).as_posix()
            safe_path(relative,project)
            size=path.stat().st_size
            if relative in STATE_FILES and size>MAX_STATE_FILE_BYTES: raise ValueError("archive state file is too large")
            total+=size
            if size>MAX_FILE_BYTES or total>MAX_TOTAL_BYTES or len(files)>=MAX_FILES: raise ValueError("archive exceeds its size or file limit")
            files.append({"path":relative,"bytes":size,"sha256":digest(path)})
    if not STATE_FILES.issubset({file["path"]for file in files}): raise ValueError("archive state is incomplete")
    files.sort(key=lambda file:file["path"])
    manifest={"schema":SCHEMA,"projectId":project,"files":files,"totalBytes":total}
    encoded=json.dumps(manifest,sort_keys=True,separators=(",",":")).encode()
    if len(encoded)>MAX_MANIFEST_BYTES: raise ValueError("archive manifest is too large")
    output.parent.mkdir(parents=True,exist_ok=True)
    temporary=output.with_name(output.name+"."+str(uuid.uuid4())+".pending")
    try:
        with os.fdopen(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),"wb") as handle, zipfile.ZipFile(handle,"w",compression=zipfile.ZIP_STORED,allowZip64=True) as archive:
            archive.writestr("archive.json",encoded)
            for file in files:
                path=source/file["path"]
                hashed=hashlib.sha256(); copied=0
                info=zipfile.ZipInfo(file["path"]); info.external_attr=(stat.S_IFREG|0o600)<<16
                with path.open("rb") as reader,archive.open(info,"w",force_zip64=True) as writer:
                    while chunk:=reader.read(1024**2):
                        copied+=len(chunk); hashed.update(chunk); writer.write(chunk)
                if copied!=file["bytes"] or hashed.hexdigest()!=file["sha256"]: raise ValueError("source changed during archive creation")
        with temporary.open("rb") as file: os.fsync(file.fileno())
        if output.exists(): raise ValueError("archive destination appeared during creation")
        os.link(temporary,output); temporary.unlink(); sync_directory(output.parent)
    except Exception:
        temporary.unlink(missing_ok=True); raise
    return {"projectId":project,"files":len(files),"bytes":total,"archiveSha256":digest(output),"manifestSha256":hashlib.sha256(encoded).hexdigest()}
def inspect(archive):
    infos=archive.infolist()
    if len(infos)>MAX_FILES+1 or len({info.filename for info in infos})!=len(infos): raise ValueError("duplicate or excessive archive entries")
    manifests=[info for info in infos if info.filename=="archive.json"]
    if len(manifests)!=1 or manifests[0].file_size>MAX_MANIFEST_BYTES: raise ValueError("archive manifest is missing or too large")
    for info in infos:
        if info.filename in STATE_FILES and info.file_size>MAX_STATE_FILE_BYTES: raise ValueError("archive state file is too large")
        if info.file_size>MAX_FILE_BYTES or info.flag_bits&1 or info.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED):
            raise ValueError("unsupported or excessive archive entry")
        if stat.S_IFMT(info.external_attr>>16) not in (0,stat.S_IFREG): raise ValueError("archive links and special files are forbidden")
        if info.file_size>max(1,info.compress_size)*200: raise ValueError("archive compression ratio exceeds its limit")
    if sum(info.file_size for info in infos)>MAX_TOTAL_BYTES+MAX_MANIFEST_BYTES: raise ValueError("archive exceeds its expanded size limit")
    manifest=json.loads(archive.read(manifests[0]))
    if not isinstance(manifest,dict): raise ValueError("invalid archive manifest")
    project=manifest.get("projectId")
    if manifest.get("schema")!=SCHEMA or not isinstance(project,str) or not ID.fullmatch(project) or not isinstance(manifest.get("files"),list):
        raise ValueError("unsupported project archive")
    expected={}
    for entry in manifest["files"]:
        if not isinstance(entry,dict): raise ValueError("invalid archive file metadata")
        name=entry.get("path")
        safe_path(name,project)
        if name in expected or type(entry.get("bytes")) is not int or not 0<=entry["bytes"]<=MAX_FILE_BYTES or not re.fullmatch(r"[a-f0-9]{64}",str(entry.get("sha256"))):
            raise ValueError("invalid archive file metadata")
        expected[name]=entry
    if set(expected)!={info.filename for info in infos if info.filename!="archive.json"} or not STATE_FILES.issubset(expected):
        raise ValueError("archive contains missing or unlisted files")
    if sum(entry["bytes"]for entry in expected.values())!=manifest.get("totalBytes"):
        raise ValueError("archive total does not match its manifest")
    for info in infos:
        if info.filename!="archive.json" and info.file_size!=expected[info.filename]["bytes"]: raise ValueError("archive entry size mismatch")
    return manifest,expected
def unpack(source, output):
    source,output=source.resolve(),output.resolve()
    if output.exists(): raise ValueError("archive extraction requires a new directory")
    if source.stat().st_size>MAX_TOTAL_BYTES+MAX_MANIFEST_BYTES+MAX_FILES*2048: raise ValueError("archive file exceeds its size limit")
    with zipfile.ZipFile(source,"r") as archive:
        manifest,expected=inspect(archive)
        temporary=output.with_name(output.name+"."+str(uuid.uuid4())+".pending")
        temporary.mkdir(parents=True,mode=0o700)
        try:
            # Every name is validated before any file is written. No extractall or symlink creation.
            for name,entry in expected.items():
                path=temporary/name
                path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                hashed=hashlib.sha256(); copied=0
                with archive.open(name,"r") as reader,path.open("xb") as writer:
                    os.chmod(path,0o600)
                    while chunk:=reader.read(1024**2):
                        copied+=len(chunk)
                        if copied>entry["bytes"]: raise ValueError("archive data exceeds its declared size")
                        hashed.update(chunk); writer.write(chunk)
                    writer.flush(); os.fsync(writer.fileno())
                if copied!=entry["bytes"] or hashed.hexdigest()!=entry["sha256"]: raise ValueError("archive data failed checksum verification")
            project_scope(temporary,manifest["projectId"])
            if output.exists(): raise ValueError("archive extraction destination appeared")
            for directory,_,_ in os.walk(temporary,topdown=False): sync_directory(directory)
            temporary.rename(output)
            sync_directory(output.parent)
        except Exception:
            if temporary.exists(): shutil.rmtree(temporary)
            raise
    return {"projectId":manifest["projectId"],"files":len(expected),"bytes":manifest["totalBytes"],"archiveSha256":digest(source)}
if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest="command",required=True)
    create=commands.add_parser("pack"); create.add_argument("--source",type=Path,required=True); create.add_argument("--output",type=Path,required=True); create.add_argument("--project",required=True)
    extract=commands.add_parser("unpack"); extract.add_argument("--source",type=Path,required=True); extract.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    print(json.dumps(pack(args.source,args.output,args.project)if args.command=="pack"else unpack(args.source,args.output)))
