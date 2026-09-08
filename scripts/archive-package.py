#!/usr/bin/env python3
"""Pack or verify and unpack a portable Hollywood Video project archive."""
import argparse, hashlib, json, os, re, shutil, stat, subprocess, uuid, zipfile
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
    # Windows does not expose POSIX directory fsync. File handles are flushed;
    # directory durability and access control follow the destination filesystem.
    if os.name=="nt": return
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

def composite_history(history):
    if history is None: return False
    if not isinstance(history,dict): raise ValueError("invalid editorial history")
    root=history.get("root",{})
    if not isinstance(root,dict) or not isinstance(root.get("clips",[]),list) or not isinstance(history.get("events",[]),list): raise ValueError("invalid editorial history")
    if root.get("schema")=="hv-edit-timeline/2" or "matteOnlyLayers" in root or any(isinstance(clip,dict) and "composite" in clip for clip in root.get("clips",[])): return True
    for event in history.get("events",[]):
        if not isinstance(event,dict) or event.get("kind")!="edit": continue
        operation=event.get("operation",{})
        if not isinstance(operation,dict): continue
        if operation.get("kind") in ("composite","matte-only") or operation.get("kind")=="replace" and "maskAction" in operation: return True
        if operation.get("kind")=="insert":
            if not isinstance(operation.get("clips",[]),list): raise ValueError("invalid editorial insertion")
            if any(isinstance(clip,dict) and "composite" in clip for clip in operation.get("clips",[])): return True
    return False

def composite_state(project, jobs):
    editorial=project.get("editLibrary",{})
    if not isinstance(editorial,dict) or not isinstance(editorial.get("sequences",[]),list): raise ValueError("invalid editorial library")
    if any(isinstance(sequence,dict) and composite_history(sequence.get("history")) for sequence in editorial.get("sequences",[])): return True
    for job in jobs:
        plans=[job.get("pictureEdit")]
        for key in ("editCheckpoint","output"):
            output=job.get(key) or {}
            if not isinstance(output,dict): raise ValueError("invalid editorial output")
            result=output.get("editorial") or {}
            if not isinstance(result,dict): raise ValueError("invalid editorial result")
            plans.append(result.get("plan"))
        for plan in plans:
            if plan is None: continue
            if not isinstance(plan,dict) or not isinstance(plan.get("sequence",{}),dict): raise ValueError("invalid editorial plan")
            if composite_history(plan.get("sequence",{}).get("history")): return True
    return False

def assembly_state(project):
    if "assemblyLibrary" not in project: return False
    library=project["assemblyLibrary"]
    if not isinstance(library,dict) or set(library)!={"schema","version","proposals","assemblies","revision"} or library.get("schema")!="hv-edit-assembly-library/1" or type(library.get("version")) is not int or not 0<=library["version"]<=100000:
        raise ValueError("invalid assembly recovery library")
    if not isinstance(library["proposals"],list) or not isinstance(library["assemblies"],list) or len(library["proposals"])>32 or len(library["assemblies"])>32:
        raise ValueError("invalid assembly recovery collections")
    nonempty=bool(library["proposals"] or library["assemblies"])
    if library["version"]==0 and nonempty: raise ValueError("an initial assembly library must be empty")
    if not nonempty:
        # These fields contain only integers, ASCII keys and empty arrays, so
        # canonical JSON has the same bytes as the planner's contentHash.
        payload={key:value for key,value in library.items() if key!="revision"}
        expected=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
        if library["revision"]!=expected: raise ValueError("the empty assembly library seal changed")
        return False
    editorial=project.get("editLibrary")
    if not isinstance(editorial,dict) or not isinstance(editorial.get("sources"),list) or len(editorial["sources"])>64:
        raise ValueError("assembly recovery lost its editorial source catalog")
    receipts={}
    for receipt in editorial["sources"]:
        if not isinstance(receipt,dict) or not isinstance(receipt.get("revision"),str) or receipt["revision"] in receipts: raise ValueError("invalid assembly original receipt")
        receipts[receipt["revision"]]=receipt
    for item in library["proposals"]+library["assemblies"]:
        if not isinstance(item,dict) or not isinstance(item.get("plan"),dict): raise ValueError("invalid assembly proposal or accepted version")
        plan=item["plan"]
        if set(plan)!={"schema","parent","ranges","join","frames","revision"} or plan.get("schema")!="hv-edit-assembly/1" or plan.get("join")!="cut": raise ValueError("invalid assembly plan")
        parent=plan.get("parent")
        if not isinstance(parent,dict) or set(parent)!={"sequenceId","historyRevision","timeline","sourceReceipts"}: raise ValueError("invalid frozen assembly parent")
        timeline=parent.get("timeline")
        if not isinstance(timeline,dict) or not isinstance(timeline.get("sources"),list) or not 1<=len(timeline["sources"])<=16 or type(timeline.get("frames")) is not int or not 1<=timeline["frames"]<=108000:
            raise ValueError("invalid assembly parent timeline")
        bindings=parent.get("sourceReceipts")
        if not isinstance(bindings,list) or len(bindings)!=len(timeline["sources"]): raise ValueError("invalid assembly parent receipt bindings")
        for facts,binding in zip(timeline["sources"],bindings):
            if not isinstance(facts,dict) or not isinstance(binding,dict) or set(binding)!={"sourceId","receiptRevision"} or not isinstance(binding.get("receiptRevision"),str): raise ValueError("invalid assembly parent original")
            receipt=receipts.get(binding["receiptRevision"])
            if not receipt or not isinstance(receipt.get("job"),dict) or receipt["job"].get("projectId")!=project["id"] or receipt.get("facts")!=facts or binding.get("sourceId")!=facts.get("id"):
                raise ValueError("assembly parent lost an owned original receipt or its measured facts")
        ranges=plan.get("ranges")
        if not isinstance(ranges,list) or not 1<=len(ranges)<=256: raise ValueError("invalid assembly ranges")
        frames=0; identities=set()
        for selected in ranges:
            if not isinstance(selected,dict) or set(selected)!={"id","fromFrame","toFrame","reason"} or not isinstance(selected.get("id"),str) or not ID.fullmatch(selected["id"]) or selected["id"] in identities:
                raise ValueError("invalid assembly range identity")
            start,end=selected.get("fromFrame"),selected.get("toFrame")
            if type(start) is not int or type(end) is not int or not 0<=start<end<=timeline["frames"] or not isinstance(selected.get("reason"),str) or not selected["reason"].strip(): raise ValueError("invalid assembly range bounds or reason")
            frames+=end-start; identities.add(selected["id"])
        if type(plan.get("frames")) is not int or plan["frames"]!=frames or not 1<=frames<=108000: raise ValueError("invalid assembly duration")
    return True

def living_script_state(project):
    if "livingScriptProposals" not in project: return False
    library=project["livingScriptProposals"]
    if not isinstance(library,dict) or set(library)!={"schema","projectId","version","proposals","revision"} or library.get("schema")!="hv-living-script-proposals/1" or library.get("projectId")!=project["id"] or type(library.get("version")) is not int or not 0<=library["version"]<=100000:
        raise ValueError("invalid screenplay proposal recovery library")
    if not isinstance(library["proposals"],list) or len(library["proposals"])>16:
        raise ValueError("invalid screenplay proposal recovery collections")
    if library["version"]==0 and library["proposals"]: raise ValueError("an initial screenplay proposal library must be empty")
    if not library["proposals"]:
        payload={key:value for key,value in library.items() if key!="revision"}
        expected=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
        if library["revision"]!=expected: raise ValueError("the empty screenplay proposal library seal changed")
    return bool(library["version"] or library["proposals"])

def living_script_acceptances_state(project):
    if "livingScriptAcceptances" not in project: return False
    library=project["livingScriptAcceptances"]
    if not isinstance(library,dict) or set(library)!={"schema","projectId","version","records","revision"} or library.get("schema")!="hv-living-script-acceptances/1" or library.get("projectId")!=project["id"] or type(library.get("version")) is not int:
        raise ValueError("invalid linked screenplay acceptance recovery library")
    if not isinstance(library["records"],list) or len(library["records"])>16 or library["version"]!=len(library["records"]):
        raise ValueError("invalid append-only screenplay acceptance recovery collections")
    if not library["records"]:
        payload={key:value for key,value in library.items() if key!="revision"}
        expected=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
        if library["revision"]!=expected: raise ValueError("the empty screenplay acceptance ledger seal changed")
    return bool(library["records"])

def verify_assembly_metadata(payload, code, schema=7, kind="assembly"):
    # New schemas require the recorded application source and Bun. Delegate full
    # seals, source receipts, masks and retime validation instead of duplicating
    # JavaScript floating-point serialization or recipe rules in Python.
    configured=os.environ.get("HV_BUN_PATH")
    executable=configured if configured else shutil.which("bun")
    if not executable: raise ValueError(f"schema {schema} {kind} verification requires Bun; set HV_BUN_PATH")
    try: executable=Path(executable).expanduser().resolve(strict=True)
    except (OSError,RuntimeError) as error: raise ValueError(f"invalid schema {schema} Bun executable") from error
    if not executable.is_file() or not os.access(executable,os.X_OK): raise ValueError(f"invalid schema {schema} Bun executable")
    repository=Path(__file__).resolve().parent.parent
    try: payload=json.dumps(payload,ensure_ascii=False,allow_nan=False,separators=(",",":")).encode("utf-8")
    except (ValueError,UnicodeError) as error: raise ValueError(f"invalid portable {kind} recovery data") from error
    if len(payload)>MAX_STATE_FILE_BYTES: raise ValueError(f"{kind} verification exceeds its metadata limit")
    try: result=subprocess.run([str(executable),"--eval",code],input=payload,stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd=repository,timeout=60,check=False)
    except (OSError,subprocess.TimeoutExpired) as error: raise ValueError(f"schema {schema} {kind} planner verification could not complete") from error
    if len(result.stdout)>8192 or len(result.stderr)>8192 or result.returncode or result.stdout!=b"verified": raise ValueError(f"invalid sealed {kind} recovery data")

def verify_assembly_planner(project):
    repository=Path(__file__).resolve().parent.parent
    module=(repository/"packages/planner/src/edit-assembly-parent.ts").as_uri()
    empty=(repository/"packages/planner/src/edit-library.ts").as_uri()
    code="import {validateProjectAssemblyLibrary} from "+json.dumps(module)+";import {emptyEditLibrary} from "+json.dumps(empty)+";try{const p=await Bun.stdin.json();validateProjectAssemblyLibrary(p.assemblyLibrary,p.id,p.editLibrary??emptyEditLibrary());process.stdout.write('verified');}catch{process.stderr.write('Invalid sealed assembly library, parent timeline or original receipts.');process.exitCode=1;}"
    verify_assembly_metadata({key:project[key] for key in ("id","assemblyLibrary","editLibrary") if key in project},code)

def verify_assembly_jobs(state,jobs,ledger,reviews):
    module=(Path(__file__).resolve().parent.parent/"packages/storage/src/snapshots.ts").as_uri()
    code="import {validateSnapshot} from "+json.dumps(module)+";try{validateSnapshot(await Bun.stdin.json());process.stdout.write('verified');}catch{process.stderr.write('Invalid sealed assembly jobs, original media or performance accounting.');process.exitCode=1;}"
    verify_assembly_metadata({"schema":"hv-state/7","projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews},code)

def verify_living_script(state,jobs,ledger,reviews):
    module=(Path(__file__).resolve().parent.parent/"packages/storage/src/snapshots.ts").as_uri()
    code="import {validateSnapshot} from "+json.dumps(module)+";try{validateSnapshot(await Bun.stdin.json());process.stdout.write('verified');}catch{process.stderr.write('Invalid frozen screenplay proposal, original version or reviewed impact.');process.exitCode=1;}"
    verify_assembly_metadata({"schema":"hv-state/8","projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews},code,8,"screenplay proposal")

def verify_living_script_acceptances(state,jobs,ledger,reviews):
    module=(Path(__file__).resolve().parent.parent/"packages/storage/src/snapshots.ts").as_uri()
    code="import {validateSnapshot} from "+json.dumps(module)+";try{validateSnapshot(await Bun.stdin.json());process.stdout.write('verified');}catch{process.stderr.write('Invalid linked screenplay acceptance, retained versions, history prefixes or exact reviewed request.');process.exitCode=1;}"
    verify_assembly_metadata({"schema":"hv-state/9","projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews},code,9,"screenplay acceptance")

def pending_script_contexts(state,jobs):
    pending=[]; decisions=[]; sources=[]
    def visit(value,depth=0):
        if depth>180: raise ValueError("pending recovery nesting exceeds its limit")
        if isinstance(value,list):
            for item in value: visit(item,depth+1)
        elif isinstance(value,dict):
            if "livingScript" in value: pending.append(value)
            if "livingScriptReview" in value: decisions.append(value)
            if value.get("schema") in ("hv-edit-source/1","hv-edit-source/2"): sources.append(value)
            for item in value.values(): visit(item,depth+1)
    visit(state); visit(jobs)
    return pending,decisions,sources

def verify_living_script_jobs(state,jobs,ledger,reviews):
    # Schema 10 also delegates nested pending contexts and historical preview decisions;
    # successful verification does not commit the proposed next screenplay version.
    module=(Path(__file__).resolve().parent.parent/"packages/storage/src/snapshots.ts").as_uri()
    code="import {validateSnapshot} from "+json.dumps(module)+";try{validateSnapshot(await Bun.stdin.json());process.stdout.write('verified');}catch{process.stderr.write('Invalid pending screenplay job, saved proposal, original version or preview decision.');process.exitCode=1;}"
    verify_assembly_metadata({"schema":"hv-state/10","projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews},code,10,"pending screenplay jobs")

def execution_contexts(state,jobs):
    # Retained originals and abandoned branches are as significant as live queue rows.
    found=[]; nodes=0
    def visit(value,depth=0):
        nonlocal nodes
        nodes+=1
        if depth>180 or nodes>5_000_000: raise ValueError("execution recovery metadata exceeds its traversal limit")
        if isinstance(value,list):
            for item in value: visit(item,depth+1)
        elif isinstance(value,dict):
            if "executionCheckpoints" in value or "shotExecutions" in value or value.get("schema")=="hv-shot-execution-capture/1": found.append(value)
            for item in value.values(): visit(item,depth+1)
    visit(state); visit(jobs)
    return found

def verify_shot_executions(state,jobs,ledger,reviews):
    module=(Path(__file__).resolve().parent.parent/"packages/storage/src/snapshots.ts").as_uri()
    code="import {validateSnapshot} from "+json.dumps(module)+";try{validateSnapshot(await Bun.stdin.json());process.stdout.write('verified');}catch{process.stderr.write('Invalid private shot execution inventory, owning job or retained source.');process.exitCode=1;}"
    verify_assembly_metadata({"schema":"hv-state/11","projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews},code,11,"shot execution")

def current_screenplay_contexts(state,jobs):
    found=False; nodes=0
    def visit(value,depth=0):
        nonlocal found,nodes
        nodes+=1
        if depth>220 or nodes>5_000_000: raise ValueError("current screenplay recovery exceeds its traversal limit")
        if isinstance(value,list):
            for item in value: visit(item,depth+1)
        elif isinstance(value,dict):
            schema=value.get("schema")
            if any(key in value for key in ("currentScreenplay","currentFilm","currentFilmReview")) or isinstance(schema,str) and schema.startswith(("hv-current-screenplay-","hv-current-film-")): found=True
            for item in value.values(): visit(item,depth+1)
    visit(state); visit(jobs)
    return found

def verify_current_screenplay(state,jobs,ledger,reviews):
    module=(Path(__file__).resolve().parent.parent/"packages/storage/src/snapshots.ts").as_uri()
    code="import {validateSnapshot} from "+json.dumps(module)+";try{validateSnapshot(await Bun.stdin.json());process.stdout.write('verified');}catch{process.stderr.write('Invalid current screenplay ancestry, accepted versions, saved proposal or runtime recovery context.');process.exitCode=1;}"
    verify_assembly_metadata({"schema":"hv-state/12","projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews},code,12,"current screenplay")

def verify_execution_media(root,project,jobs):
    payload=[]
    for job in jobs:
        if "executionCheckpoints" not in job: continue
        count=job.get("checkpointShots")
        if type(count) is not int or not 0<=count<=60: raise ValueError("invalid execution checkpoint count")
        if count==0: continue
        manifest=root/"artifacts"/project/job["id"]/"clips/manifest.json"
        if any(part.is_symlink() for part in (manifest,*manifest.parents)): raise ValueError("execution checkpoint links are forbidden")
        if not manifest.is_file() or not 0<manifest.stat().st_size<=MAX_STATE_FILE_BYTES: raise ValueError("execution checkpoint manifest is missing or exceeds its bound")
        body=json.loads(manifest.read_text(encoding="utf-8"))
        clips=body if isinstance(body,list) else body.get("clips") if isinstance(body,dict) and set(body)=={"schema","clips"} and body.get("schema")=="hv-clips/1" else None
        if not isinstance(clips,list) or len(clips)!=count: raise ValueError("execution checkpoint manifest count changed")
        if execution_contexts({},clips): raise ValueError("private execution evidence cannot appear in public clip manifests")
        for clip in clips:
            if not isinstance(clip,dict) or not isinstance(clip.get("renderRecord"),dict) or not isinstance(clip["renderRecord"].get("files"),dict): raise ValueError("execution checkpoint lost its sealed shot record")
            for field,role in (("path","video"),("audioPath","audio"),("posterPath","poster"),("sourcePosterPath","sourcePoster")):
                key=clip.get(field); record=clip["renderRecord"]["files"].get(role)
                if bool(key)!=bool(record): raise ValueError("execution checkpoint lost a media role")
                if not record: continue
                if not isinstance(key,str) or not isinstance(record,dict): raise ValueError("invalid execution checkpoint media")
                # Local manifests have absolute paths; normalize only their historical owner
                # suffix, then require exact equality with the sealed portable file inventory.
                normalized=key.replace("\\","/"); marker="/"+project+"/"+job["id"]+"/"
                position=normalized.find(marker)
                portable=normalized[position+1:] if position>=0 else normalized
                safe_path("artifacts/"+portable,project)
                if not portable.startswith(project+"/"+job["id"]+"/") or portable!=record.get("path"): raise ValueError("execution checkpoint media escaped or changed its sealed role")
                path=root/"artifacts"/portable
                if any(part.is_symlink() for part in (path,*path.parents)): raise ValueError("execution checkpoint links are forbidden")
                if not path.is_file() or path.stat().st_size!=record.get("bytes") or digest(path)!=record.get("sha256"): raise ValueError("execution checkpoint media is missing or corrupt")
        payload.append({"job":job,"clips":clips})
    if payload:
        module=(Path(__file__).resolve().parent.parent/"packages/planner/src/shot-execution-inventory.ts").as_uri()
        code="import {validateShotExecutionClips,validateJobExecutionCheckpoint} from "+json.dumps(module)+";try{for(const {job,clips} of await Bun.stdin.json()){const payload=validateShotExecutionClips(job,clips);if(!payload)throw Error('inventory');validateJobExecutionCheckpoint(job,payload);if(clips.length!==job.checkpointShots||clips.reduce((n,c)=>n+Math.round(c.durationSec*30),0)!==job.checkpointFrame)throw Error('checkpoint');}process.stdout.write('verified');}catch{process.stderr.write('Invalid execution checkpoint records, captures, dispatch journal or frame clock.');process.exitCode=1;}"
        verify_assembly_metadata(payload,code,11,"execution checkpoint")

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
    if any(event.get("projectId")!=project for event in ledger.get("events",[])):
        raise ValueError("archive billing belongs to another project or remains reserved")
    audio=ledger.get("audioAttempts",[])
    if not isinstance(audio,list) or any(not isinstance(item,dict) or item.get("projectId")!=project for item in audio):
        raise ValueError("archive audio accounting belongs to another project")
    lip_sync=ledger.get("lipSyncAttempts",[])
    if not isinstance(lip_sync,list) or any(not isinstance(item,dict) or item.get("projectId")!=project for item in lip_sync):
        raise ValueError("archive lip-sync accounting belongs to another project")
    schema=json.loads((root/"snapshot.json").read_text()).get("schema")
    if schema not in ("hv-state/1","hv-state/2","hv-state/3","hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12") or ("lipSyncAttempts" in ledger or any(job.get("stage")=="lip-sync" for job in jobs)) and schema=="hv-state/1":
        raise ValueError("lip-sync recovery requires state schema 2")
    pending_jobs,pending_decisions,pending_sources=pending_script_contexts(state,jobs)
    if current_screenplay_contexts(state,jobs) and schema!="hv-state/12": raise ValueError("current screenplay recovery requires state schema 12")
    if execution_contexts(state,jobs) and schema not in ("hv-state/11","hv-state/12"): raise ValueError("private shot execution recovery requires state schema 11")
    if (pending_jobs or pending_decisions) and schema not in ("hv-state/10","hv-state/11","hv-state/12"): raise ValueError("pending screenplay jobs and preview decisions require state schema 10")
    assemblies=assembly_state(state["projects"][0])
    living_script=living_script_state(state["projects"][0])
    living_acceptances=living_script_acceptances_state(state["projects"][0])
    if living_acceptances and schema not in ("hv-state/9","hv-state/10","hv-state/11","hv-state/12"): raise ValueError("linked screenplay acceptance recovery requires state schema 9")
    if living_script and schema not in ("hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12"): raise ValueError("living screenplay proposal recovery requires state schema 8")
    assembly_jobs=[job for job in jobs if job.get("stage")=="assembly-edit" or "assemblyEdit" in job or "assemblyCheckpoint" in job or isinstance(job.get("output"),dict) and "assembly" in job["output"]]
    if (assemblies or assembly_jobs) and schema not in ("hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12"): raise ValueError("alternate assembly recovery requires state schema 7")
    if schema=="hv-state/7" and "assemblyLibrary" in state["projects"][0] and not assembly_jobs: verify_assembly_planner(state["projects"][0])
    if schema not in ("hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12") and composite_state(state["projects"][0],jobs): raise ValueError("authored mask and matte recovery requires state schema 6")
    holds=ledger.get("reservations",[])
    if not isinstance(holds,list) or any(not isinstance(item,dict) for item in holds) or len({item.get("jobId") for item in holds})!=len(holds):
        raise ValueError("invalid retained audio holds")
    attempts=[{**item,"stage":"audio-take"}for item in audio]+[{**item,"stage":"lip-sync"}for item in lip_sync]
    pending={item.get("jobId"):item for item in attempts if item.get("status") in ("running","unknown")}
    if len({item.get("jobId") for item in attempts})!=len(attempts): raise ValueError("duplicate performance dispatch job")
    if len(pending)!=len(holds): raise ValueError("archive audio liabilities require matching holds")
    for hold in holds:
        attempt=pending.get(hold.get("jobId"))
        if not attempt or hold.get("stage")!=attempt.get("stage") or hold.get("amountUsd")!=attempt.get("estimatedUsd") or hold.get("remainingUsd")!=attempt.get("estimatedUsd") or attempt.get("actualUsd") is not None:
            raise ValueError("archive billing remains reserved without audio provenance")
    reviews=json.loads((root/"state/operator-review-queue.json").read_text())
    if not isinstance(reviews,list) or any(item.get("projectId")!=project for item in reviews):
        raise ValueError("archive operator review belongs to another project")
    if schema=="hv-state/12":
        verify_current_screenplay(state,jobs,ledger,reviews)
        verify_execution_media(root,project,jobs)
    elif schema=="hv-state/11":
        verify_shot_executions(state,jobs,ledger,reviews)
        verify_execution_media(root,project,jobs)
    elif schema=="hv-state/10": verify_living_script_jobs(state,jobs,ledger,reviews)
    elif schema=="hv-state/9": verify_living_script_acceptances(state,jobs,ledger,reviews)
    elif schema=="hv-state/8": verify_living_script(state,jobs,ledger,reviews)
    elif assembly_jobs: verify_assembly_jobs(state,jobs,ledger,reviews)
    if any(item.get("projectId")!=project for item in state.get("takedownLog",[])):
        raise ValueError("archive history belongs to another project")
    job_ids={job.get("id") for job in jobs}
    artifact_root=root/"artifacts"/project
    assets=state["projects"][0].get("referenceAssets",[])
    if not isinstance(assets,list) or len(assets)>96 or any(not isinstance(asset,dict) or not isinstance(asset.get("id"),str)for asset in assets) or len({asset.get("id")for asset in assets})!=len(assets):
        raise ValueError("invalid reference catalog")
    expected_references=set()
    for asset in assets:
        if asset.get("projectId")!=project or not ID.fullmatch(asset["id"]) or not isinstance(asset.get("sha256"),str) or not re.fullmatch(r"[a-f0-9]{64}",asset["sha256"]):
            raise ValueError("archive reference belongs to another project or has invalid metadata")
        path=artifact_root/"references"/asset["id"]/(asset["sha256"]+".png")
        if any(part.is_symlink()for part in (path,*path.parents)): raise ValueError("archive reference links are forbidden")
        if not path.is_file() or path.stat().st_size!=asset.get("bytes") or digest(path)!=asset["sha256"]:
            raise ValueError("archive reference is missing or corrupt")
        expected_references.add(path.relative_to(artifact_root/"references").as_posix())
    references=artifact_root/"references"
    if references.exists() and {path.relative_to(references).as_posix()for path in references.rglob("*")if path.is_file()}!=expected_references:
        raise ValueError("archive contains an unindexed reference")
    sounds=state["projects"][0].get("soundLibrary",{}).get("assets",[])
    if schema not in ("hv-state/3","hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12") and ("soundLibrary" in state["projects"][0] or any(job.get("stage")=="sound-mix" or "soundMix" in job for job in jobs)): raise ValueError("sound recovery requires state schema 3")
    editorial=state["projects"][0].get("editLibrary")
    edit_jobs=[job for job in jobs if job.get("stage")=="picture-edit" or "pictureEdit" in job or "editorial" in job.get("output",{})]
    if (editorial is not None or edit_jobs) and schema not in ("hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12"): raise ValueError("editorial recovery requires state schema 4")
    if schema not in ("hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12") and ("graphicLibrary" in state["projects"][0] or any(job.get("stage")=="motion-graphic" or "graphicRender" in job or "graphicOutput" in job or "graphicCheckpoint" in job for job in jobs)): raise ValueError("graphic recovery requires state schema 5")
    edit_sources=list(pending_sources) if pending_jobs else []
    current_screenplay=state["projects"][0].get("currentScreenplay")
    if current_screenplay is not None:
        if not isinstance(current_screenplay,dict): raise ValueError("invalid current screenplay library")
        origin=current_screenplay.get("origin")
        if origin is not None:
            request=origin.get("request") if isinstance(origin,dict) else None
            original=request.get("source") if isinstance(request,dict) else None
            if not isinstance(original,dict): raise ValueError("current screenplay lost its bootstrap original")
            # The full schema-12 replay binds every accepted/proposed lineage to this
            # same immutable origin. Require byte custody once, through the original
            # job or a verified retained carrier; an expired original path is optional.
            edit_sources.append(original)
    if living_script:
        for proposal in state["projects"][0]["livingScriptProposals"]["proposals"]:
            frozen=proposal.get("editorial") if isinstance(proposal,dict) else None
            if not isinstance(frozen,dict) or not isinstance(frozen.get("sources"),list) or len(frozen["sources"])>64: raise ValueError("invalid frozen screenplay editorial originals")
            edit_sources.extend(frozen["sources"])
    if living_acceptances:
        for record in state["projects"][0]["livingScriptAcceptances"]["records"]:
            request=record.get("request") if isinstance(record,dict) else None
            recut=request.get("recutInput") if isinstance(request,dict) else None
            frozen=recut.get("library") if isinstance(recut,dict) else None
            if not isinstance(frozen,dict) or not isinstance(frozen.get("sources"),list) or len(frozen["sources"])>64 or not isinstance(recut.get("generated"),dict): raise ValueError("invalid frozen screenplay acceptance originals")
            edit_sources.extend(frozen["sources"])
            edit_sources.append(recut["generated"])
    if editorial is not None:
        if not isinstance(editorial,dict) or editorial.get("schema")!="hv-edit-library/1" or not isinstance(editorial.get("sources"),list) or len(editorial["sources"])>64:
            raise ValueError("invalid editorial source library")
        edit_sources.extend(editorial["sources"])
    carriers=[]
    for job in assembly_jobs:
        plan=job.get("assemblyEdit",{})
        if not isinstance(plan,dict) or not isinstance(plan.get("bindings"),list) or not 1<=len(plan["bindings"])<=16: raise ValueError("invalid assembly original bindings")
        for binding in plan["bindings"]:
            if not isinstance(binding,dict) or not isinstance(binding.get("source"),dict): raise ValueError("invalid assembly original receipt")
            edit_sources.append(binding["source"])
    for job in edit_jobs+assembly_jobs:
        for field,kind in (("output","editorial"),("editCheckpoint","editorial"),("output","assembly"),("assemblyCheckpoint","assembly")):
            output=job.get(field) or {}
            if not isinstance(output,dict): raise ValueError("invalid retained editorial output")
            result=output.get(kind)
            if result is None: continue
            if not isinstance(result,dict) or not isinstance(result.get("prepared"),dict): raise ValueError("invalid retained editorial preparation")
            prepared=result["prepared"].get("sources",[])
            if not isinstance(prepared,list) or len(prepared)>16 or not isinstance(result.get("files"),list): raise ValueError("invalid retained editorial sources")
            for retained in prepared:
                if not isinstance(retained,dict) or not isinstance(retained.get("receipt"),dict): raise ValueError("invalid retained editorial source")
                carriers.append((job,retained,result["files"])); edit_sources.append(retained["receipt"])
    # A pending plan names an exact historical carrier, not an interchangeable path.
    # The full Bun validator binds its metadata; byte custody must retain that mapping.
    for pending_job in pending_jobs:
        plan=pending_job.get("livingScript")
        if not isinstance(plan,dict) or not isinstance(plan.get("binding"),dict): raise ValueError("invalid pending screenplay carrier")
        binding=plan["binding"]; owner=binding.get("owner",{}); original=binding.get("source")
        carrier=next((job for job in jobs if job.get("id")==owner.get("jobId") and job.get("projectId")==project and job.get("status")=="done"),None)
        if not carrier or not isinstance(original,dict) or not isinstance(binding.get("files"),list): raise ValueError("pending screenplay lost its exact carrier job")
        expected=original.get("files") if carrier["id"]==original.get("job",{}).get("id") else next(([copy["copy"] for copy in retained.get("copies",[])] for job,retained,_ in carriers if job["id"]==carrier["id"] and retained["receipt"]==original),None)
        if expected!=binding["files"]: raise ValueError("pending screenplay carrier mapping changed")
        edit_sources.append(original)
        for record in binding["files"]:
            key=record.get("path"); safe_path("artifacts/"+key if isinstance(key,str) else key,project)
            if not key.startswith(project+"/"+carrier["id"]+"/"): raise ValueError("pending screenplay escaped its carrier")
            path=root/"artifacts"/key
            if any(part.is_symlink() for part in (path,*path.parents)): raise ValueError("pending screenplay links are forbidden")
            if not path.is_file() or path.stat().st_size!=record.get("bytes") or digest(path)!=record.get("sha256"): raise ValueError("pending screenplay carrier is missing or corrupt")
    for job in jobs:
        if ("livingScript" not in job and "executionCheckpoints" not in job) or job.get("status")!="done": continue
        output=job.get("output")
        if not isinstance(output,dict) or not isinstance(output.get("shotRenders"),list): raise ValueError("pending screenplay lost its completed film")
        for shot in output["shotRenders"]:
            if not isinstance(shot,dict) or not isinstance(shot.get("files"),dict): raise ValueError("invalid pending shot inventory")
            for record in shot["files"].values():
                if not isinstance(record,dict): raise ValueError("invalid pending shot file")
                key=record.get("path"); safe_path("artifacts/"+key if isinstance(key,str) else key,project)
                if not key.startswith(project+"/"+job["id"]+"/"): raise ValueError("pending shot escaped its owner")
                path=root/"artifacts"/key
                if any(part.is_symlink() for part in (path,*path.parents)): raise ValueError("pending shot links are forbidden")
                if not path.is_file() or path.stat().st_size!=record.get("bytes") or digest(path)!=record.get("sha256"): raise ValueError("pending screenplay shot media is missing or corrupt")
        # Normal Job output contains sealed shot records but no hash inventory for the
        # muxed film/HLS. Preserve these required artifacts; archive entry hashes bind their
        # exact captured bytes, and S3 restore also checks the existing artifact ledger.
        for field in ("mp4Path","captionsPath","manifestPath","hlsPlaylistPath"):
            key=output.get(field); safe_path("artifacts/"+key if isinstance(key,str) else key,project)
            if not key.startswith(project+"/"+job["id"]+"/"): raise ValueError("pending film escaped its owner")
            path=root/"artifacts"/key
            if any(part.is_symlink() for part in (path,*path.parents)): raise ValueError("pending film links are forbidden")
            if not path.is_file() or not 0<path.stat().st_size<=MAX_FILE_BYTES: raise ValueError("pending screenplay completed media is missing")
    for source in edit_sources:
        if not isinstance(source,dict): raise ValueError("invalid editorial source")
        original=source.get("job",{})
        if original.get("projectId")!=project or not isinstance(original.get("id"),str) or not ID.fullmatch(original["id"]): raise ValueError("editorial source escaped its original job")
        if not isinstance(source.get("files"),list) or not 1<=len(source["files"])<=30000: raise ValueError("invalid editorial source inventory")
        for record in source["files"]:
            key=record.get("path")
            safe_path("artifacts/"+key if isinstance(key,str) else key,project)
            if not key.startswith(project+"/"+original["id"]+"/"): raise ValueError("editorial source escaped its original job")
        current=next((job for job in jobs if job.get("id")==original["id"] and job.get("output")==original.get("output") and job.get("graphicOutput")==original.get("graphicOutput")),None)
        candidates=[(original["id"],source["files"])] if current else []
        for job,retained,inventory in carriers:
            if retained["receipt"]!=source: continue
            copies=retained.get("copies")
            if not isinstance(copies,list) or len(copies)!=len(source["files"]): raise ValueError("invalid editorial source copies")
            for index,copy in enumerate(copies):
                record=copy.get("copy",{})
                if copy.get("original")!=source["files"][index] or record.get("bytes")!=copy["original"].get("bytes") or record.get("sha256")!=copy["original"].get("sha256") or record not in inventory:
                    raise ValueError("retained editorial source differs from its original")
            candidates.append((job["id"],[copy["copy"] for copy in copies]))
        if not candidates: raise ValueError("archive lost an editorial source job or retained carrier")
        available=False
        for owner,records in candidates:
            intact=True
            for record in records:
                key=record.get("path")
                safe_path("artifacts/"+key if isinstance(key,str) else key,project)
                if not key.startswith(project+"/"+owner+"/"): raise ValueError("editorial source escaped its carrier job")
                path=root/"artifacts"/key
                if any(part.is_symlink() for part in (path,*path.parents)): raise ValueError("editorial source links are forbidden")
                if not path.is_file() or path.stat().st_size!=record.get("bytes") or digest(path)!=record.get("sha256"): intact=False; break
            available=available or intact
        if not available: raise ValueError("archive editorial source is missing or corrupt")
    for job in assembly_jobs:
        for field in ("assemblyCheckpoint","output"):
            output=job.get(field)
            if output is None: continue
            result=output.get("assembly",{}) if isinstance(output,dict) else {}
            records=result.get("files") if isinstance(result,dict) else None
            if not isinstance(records,list) or not 1<=len(records)<=80000 or any(not isinstance(record,dict) for record in records) or len({record.get("path") for record in records})!=len(records): raise ValueError("invalid assembly inventory")
            for record in records:
                key=record.get("path"); safe_path("artifacts/"+key if isinstance(key,str) else key,project)
                if not key.startswith(project+"/"+job["id"]+"/"): raise ValueError("assembly escaped its owner")
                path=root/"artifacts"/key
                if any(part.is_symlink() for part in (path,*path.parents)): raise ValueError("assembly links are forbidden")
                if not path.is_file() or path.stat().st_size!=record.get("bytes") or digest(path)!=record.get("sha256"): raise ValueError("archive assembly is missing or corrupt")
    if not isinstance(sounds,list) or len(sounds)>64 or any(not isinstance(asset,dict) or not isinstance(asset.get("id"),str) for asset in sounds) or len({asset.get("id") for asset in sounds})!=len(sounds):
        raise ValueError("invalid sound catalog")
    for job in jobs:
        output=job.get("graphicOutput") or job.get("graphicCheckpoint")
        if not output: continue
        records=output.get("files")
        if job.get("stage")!="motion-graphic" or not isinstance(records,list) or len(records)>18020 or len({f.get("path") for f in records})!=len(records): raise ValueError("invalid graphic inventory")
        for record in records:
            key=record.get("path")
            safe_path("artifacts/"+key if isinstance(key,str) else key,project)
            if not key.startswith(project+"/"+job["id"]+"/"): raise ValueError("graphic escaped its owner")
            path=root/"artifacts"/key
            if any(part.is_symlink() for part in (path,*path.parents)): raise ValueError("graphic links are forbidden")
            if not path.is_file() or path.stat().st_size!=record.get("bytes") or digest(path)!=record.get("sha256"): raise ValueError("archive graphic is missing or corrupt")
    expected_sounds=set()
    for asset in sounds:
        if asset.get("projectId")!=project or not ID.fullmatch(asset["id"]): raise ValueError("archive sound belongs to another project")
        for kind in ("original","audio"):
            record=asset.get(kind,{})
            if not isinstance(record.get("sha256"),str) or not re.fullmatch(r"[a-f0-9]{64}",record["sha256"]): raise ValueError("invalid sound checksum")
            path=artifact_root/"sounds"/asset["id"]/(kind+"-"+record["sha256"]+".wav")
            if any(part.is_symlink() for part in (path,*path.parents)): raise ValueError("archive sound links are forbidden")
            if not path.is_file() or path.stat().st_size!=record.get("bytes") or digest(path)!=record["sha256"]: raise ValueError("archive sound is missing or corrupt")
            expected_sounds.add(path.relative_to(artifact_root/"sounds").as_posix())
    sound_root=artifact_root/"sounds"
    if sound_root.exists() and {path.relative_to(sound_root).as_posix() for path in sound_root.rglob("*") if path.is_file()}!=expected_sounds: raise ValueError("archive contains an unindexed sound")
    if artifact_root.exists() and any(child.name not in job_ids|({"references"}if assets else set())|({"sounds"}if sounds else set()) for child in artifact_root.iterdir()):
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
        with temporary.open("r+b") as file: os.fsync(file.fileno())
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
