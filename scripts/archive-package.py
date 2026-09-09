#!/usr/bin/env python3
"""Pack or verify and unpack a portable Hollywood Video project archive."""
import argparse, hashlib, json, os, re, shutil, stat, subprocess, tempfile, uuid, zipfile
from pathlib import Path
from contextlib import contextmanager

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
            if any(key in value for key in ("currentScreenplay","currentFilm","currentFilmOrigins","currentFilmCheckpoint","currentFilmReview")) or isinstance(schema,str) and schema.startswith(("hv-current-screenplay-","hv-current-film-")): found=True
            for item in value.values(): visit(item,depth+1)
    visit(state); visit(jobs)
    return found

def current_film_sources(state,jobs):
    found=[]; nodes=0
    def visit(value,depth=0):
        nonlocal nodes
        nodes+=1
        if depth>220 or nodes>5_000_000: raise ValueError("current-film source recovery exceeds its traversal limit")
        if isinstance(value,list):
            for item in value: visit(item,depth+1)
        elif isinstance(value,dict):
            if value.get("schema") in ("hv-edit-source/3","hv-edit-source/4"): found.append(value)
            for item in value.values(): visit(item,depth+1)
    visit(state); visit(jobs)
    return found

def verify_current_screenplay(state,jobs,ledger,reviews,schema=12):
    module=(Path(__file__).resolve().parent.parent/"packages/storage/src/snapshots.ts").as_uri()
    code="import {validateSnapshot} from "+json.dumps(module)+";try{validateSnapshot(await Bun.stdin.json());process.stdout.write('verified');}catch{process.stderr.write('Invalid current screenplay ancestry, accepted versions, saved proposal or runtime recovery context.');process.exitCode=1;}"
    verify_assembly_metadata({"schema":"hv-state/"+str(schema),"projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews},code,schema,"current screenplay")

def current_film_mixed_contexts(state,jobs):
    found=False; nodes=0
    schemas={"hv-current-film-job/3","hv-current-film-checkpoint/3","hv-current-film-output/3","hv-current-film-clock/3","hv-current-film-preview-review/3",
        "hv-current-film-origins/1","hv-current-film-adoption/1","hv-current-film-assembly-inputs/3","hv-current-film-retained-execution/1","hv-current-film-execution-projection/1","hv-current-film-reuse-review/1"}
    def visit(value,depth=0):
        nonlocal found,nodes
        nodes+=1
        if depth>220 or nodes>5_000_000: raise ValueError("mixed current-film recovery exceeds its traversal limit")
        if isinstance(value,list):
            for item in value: visit(item,depth+1)
        elif isinstance(value,dict):
            schema=value.get("schema")
            if "currentFilmOrigins" in value or isinstance(schema,str) and schema in schemas: found=True
            for item in value.values(): visit(item,depth+1)
    visit(state); visit(jobs)
    return found

def mixed_current_film(job):
    plan=job.get("currentFilm")
    return isinstance(plan,dict) and plan.get("schema")=="hv-current-film-job/3"

def current_film_proof_contexts(state,jobs):
    found=False; nodes=0
    schemas={"hv-current-film-prepared-proof/1","hv-current-film-proof/1","hv-current-film-proof-target/1","hv-current-film-proof-copies/1","hv-current-film-proof-closure/1"}
    def visit(value,depth=0):
        nonlocal found,nodes
        nodes+=1
        if depth>220 or nodes>5_000_000: raise ValueError("current-film proof recovery exceeds its traversal limit")
        if isinstance(value,list):
            for item in value: visit(item,depth+1)
        elif isinstance(value,dict):
            schema=value.get("schema")
            if "currentFilmProof" in value or isinstance(schema,str) and schema in schemas: found=True
            for item in value.values(): visit(item,depth+1)
    visit(state); visit(jobs)
    return found

def verify_current_film_mixed_media(root,items):
    module=(Path(__file__).resolve().parent/"verify-current-film-mixed-archive.ts").as_uri()
    code="import {verifyCurrentFilmMixedArchive} from "+json.dumps(module)+";try{const {artifactRoot,jobs}=await Bun.stdin.json();for(const job of jobs)await verifyCurrentFilmMixedArchive(job,artifactRoot);process.stdout.write('verified');}catch{process.stderr.write('Invalid mixed current-film original inventory, selected media, delivery or actual frame clock.');process.exitCode=1;}"
    verify_assembly_metadata({"artifactRoot":str((root/"artifacts").resolve()),"jobs":items},code,16 if editorial16_contexts({},items,False)[0] else 15 if current_film_proof_contexts({},items) else 14,"mixed current-film media")

def mixed_original_carriers(jobs,project):
    # Called only after full schema-14 snapshot validation. This is an internal
    # recovery mapping, never a public edit binding or a V3 editable-source receipt.
    carriers=[]
    for job in jobs:
        if not mixed_current_film(job) or "currentFilmOrigins" not in job: continue
        prepared=job["currentFilmOrigins"]
        if not isinstance(prepared,dict) or not isinstance(prepared.get("origins"),list) or not isinstance(job["currentFilm"].get("origins"),list): raise ValueError("invalid mixed current-film prepared originals")
        originals={origin["id"]:origin for origin in job["currentFilm"]["origins"]}
        if len(originals)!=len(prepared["origins"]): raise ValueError("mixed current-film lost its full original inventory")
        for entry in prepared["origins"]:
            origin=originals.get(entry.get("originId")) if isinstance(entry,dict) else None
            source=origin.get("binding",{}).get("source") if isinstance(origin,dict) else None
            copies=entry.get("copies") if isinstance(entry,dict) else None
            if not isinstance(source,dict) or source.get("schema")!="hv-edit-source/3" or source.get("job",{}).get("projectId")!=project or not isinstance(copies,list) or len(copies)!=len(source.get("files",[])):
                raise ValueError("mixed current-film original changed its exact owning source")
            retained=[]
            for original,copy in zip(source["files"],copies):
                owned=copy.get("owned") if isinstance(copy,dict) else None
                prefix=project+"/"+job["id"]+"/originals/"+entry["originId"]+"/"
                if not isinstance(owned,dict) or copy.get("original")!=original or owned.get("path")!=prefix+original["path"] or owned.get("sha256")!=original.get("sha256") or owned.get("bytes")!=original.get("bytes"):
                    raise ValueError("mixed current-film prepared copy escaped its original namespace")
                retained.append({"original":original,"copy":owned})
            carriers.append((job,{"receipt":source,"copies":retained},[copy["copy"] for copy in retained]))
    return carriers

def proof_original_carriers(jobs,project):
    # Full schema-15 validation establishes each marker, closure and namespace.
    # This maps owned proof bytes back to immutable originals; it adds no jobs.
    carriers=[]
    for job in jobs:
        if "currentFilmProof" not in job: continue
        marker=job["currentFilmProof"]
        if not mixed_current_film(job) or not isinstance(marker,dict) or not isinstance(marker.get("specification"),dict): raise ValueError("invalid prepared proof owner")
        specification=marker["specification"]; receipts={}; nodes=0
        def visit(value,depth=0):
            nonlocal nodes
            nodes+=1
            if depth>220 or nodes>5_000_000: raise ValueError("proof source mapping exceeds its traversal bound")
            if isinstance(value,list):
                for item in value: visit(item,depth+1)
            elif isinstance(value,dict):
                if value.get("schema") in ("hv-edit-source/1","hv-edit-source/2","hv-edit-source/3","hv-edit-source/4"):
                    revision=value.get("revision")
                    if not isinstance(revision,str) or revision in receipts and receipts[revision]!=value: raise ValueError("proof source identities disagree")
                    receipts[revision]=value
                for item in value.values(): visit(item,depth+1)
        # A direct selected receipt belongs to the owning V3 plan. Its original
        # V2 job in frozenContext need not contain a receipt for itself. Both
        # scopes already passed full snapshot/closure validation; collect their
        # exact receipts under one bound and reject conflicting repeated seals.
        visit(job["currentFilm"])
        visit(specification.get("frozenContext"))
        groups=specification.get("carriers")
        if not isinstance(groups,list) or len(groups)>64: raise ValueError("invalid complete proof source groups")
        for group in groups:
            source=receipts.get(group.get("receiptRevision")) if isinstance(group,dict) else None
            copies=group.get("copies") if isinstance(group,dict) else None
            if not isinstance(source,dict) or source.get("job",{}).get("projectId")!=project or not isinstance(copies,list) or len(copies)!=len(source.get("files",[])): raise ValueError("prepared proof lost its original receipt")
            retained=[]
            for original,copy in zip(source["files"],copies):
                owned=copy.get("owned") if isinstance(copy,dict) else None
                prefix=project+"/"+job["id"]+"/proof/originals/"+source["revision"]+"/"
                if not isinstance(owned,dict) or copy.get("original")!=original or owned.get("path")!=prefix+original["path"] or owned.get("sha256")!=original.get("sha256") or owned.get("bytes")!=original.get("bytes"): raise ValueError("prepared proof escaped its original namespace")
                retained.append({"original":original,"copy":owned})
            carriers.append((job,{"receipt":source,"copies":retained},[copy["copy"] for copy in retained]))
    return carriers

def verify_current_source_media(items):
    # The full schema-13 validator first establishes exact receipt ownership. Each root
    # here is either the original artifact root or its validated prepared-copy namespace.
    # The original job and portable file identities remain byte-for-byte unchanged.
    media=(Path(__file__).resolve().parent.parent/"packages/queue/src/current-film-media.ts").as_uri()
    code="import {verifyCurrentFilmMedia} from "+json.dumps(media)+";try{for(const {job,artifactRoot} of await Bun.stdin.json())await verifyCurrentFilmMedia(job,artifactRoot);process.stdout.write('verified');}catch{process.stderr.write('Invalid retained current-film bytes, native speech or actual frame clock.');process.exitCode=1;}"
    verify_assembly_metadata(items,code,13,"retained current-film media")

def proof_owned_pending_jobs(jobs):
    # Only exact copied source receipts and explicitly copied preview/original
    # jobs qualify. Arbitrary nested pending metadata does not gain byte custody.
    owned=set()
    for job in jobs:
        proof=job.get("currentFilmProof",{}).get("specification",{})
        receipts={group["receiptRevision"] for group in proof.get("carriers",[])}
        selected={group["jobId"] for group in proof.get("previews",[])}|{group["jobId"] for group in proof.get("carriers",[]) if group.get("kind")=="original"}
        nodes=0
        def visit(value,depth=0):
            nonlocal nodes
            nodes+=1
            if depth>220 or nodes>5_000_000: raise ValueError("proof pending scope exceeds its traversal bound")
            if isinstance(value,list):
                for item in value: visit(item,depth+1)
            elif isinstance(value,dict):
                if value.get("schema") in ("hv-edit-source/1","hv-edit-source/2","hv-edit-source/3","hv-edit-source/4") and value.get("revision") in receipts:
                    original=value.get("job")
                    if isinstance(original,dict) and "livingScript" in original: owned.add(json.dumps(original,sort_keys=True,separators=(",",":")))
                for item in value.values(): visit(item,depth+1)
        context=proof.get("frozenContext",{}); visit(context)
        for original in context.get("jobs",[]):
            if original.get("id") in selected and "livingScript" in original: owned.add(json.dumps(original,sort_keys=True,separators=(",",":")))
    return owned

def verify_execution_media(root,project,jobs):
    payload=[]; current_payload=[]; mixed_payload=[]
    for job in jobs:
        if "executionCheckpoints" not in job and "currentFilm" not in job: continue
        count=job.get("checkpointShots")
        if type(count) is not int or not 0<=count<=60: raise ValueError("invalid execution checkpoint count")
        if mixed_current_film(job):
            # Origins are independently durable before slot one. V3 never owns a
            # legacy public clips manifest; the fixed bridge checks its full inventory.
            mixed_payload.append(job)
            continue
        if count==0:
            if "currentFilmCheckpoint" in job: current_payload.append({"job":job,"clips":[]})
            continue
        manifest=root/"artifacts"/project/job["id"]/"clips/manifest.json"
        if any(part.is_symlink() for part in (manifest,*manifest.parents)): raise ValueError("execution checkpoint links are forbidden")
        if not manifest.is_file() or not 0<manifest.stat().st_size<=MAX_STATE_FILE_BYTES: raise ValueError("execution checkpoint manifest is missing or exceeds its bound")
        body=json.loads(manifest.read_text(encoding="utf-8"))
        clips=body if isinstance(body,list) else body.get("clips") if isinstance(body,dict) and set(body)=={"schema","clips"} and body.get("schema")=="hv-clips/1" else None
        if not isinstance(clips,list) or len(clips)!=count: raise ValueError("execution checkpoint manifest count changed")
        if execution_contexts({},clips) or current_screenplay_contexts({},clips): raise ValueError("private execution evidence cannot appear in public clip manifests")
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
        (current_payload if "currentFilm" in job else payload).append({"job":job,"clips":clips})
    if payload:
        module=(Path(__file__).resolve().parent.parent/"packages/planner/src/shot-execution-inventory.ts").as_uri()
        code="import {validateShotExecutionClips,validateJobExecutionCheckpoint} from "+json.dumps(module)+";try{for(const {job,clips} of await Bun.stdin.json()){const payload=validateShotExecutionClips(job,clips);if(!payload)throw Error('inventory');validateJobExecutionCheckpoint(job,payload);if(clips.length!==job.checkpointShots||clips.reduce((n,c)=>n+Math.round(c.durationSec*30),0)!==job.checkpointFrame)throw Error('checkpoint');}process.stdout.write('verified');}catch{process.stderr.write('Invalid execution checkpoint records, captures, dispatch journal or frame clock.');process.exitCode=1;}"
        verify_assembly_metadata(payload,code,11,"execution checkpoint")
    if current_payload:
        # Static trusted modules validate the exact V2 journal/manifest and actual media,
        # including ffprobe source/final clocks. Current permissions are never checked here.
        context=(Path(__file__).resolve().parent.parent/"packages/planner/src/current-film-job-context.ts").as_uri()
        media=(Path(__file__).resolve().parent.parent/"packages/queue/src/current-film-media.ts").as_uri()
        code="import {validateCurrentFilmClips} from "+json.dumps(context)+";import {verifyCurrentFilmMedia} from "+json.dumps(media)+";try{const {artifactRoot,items}=await Bun.stdin.json();for(const {job,clips} of items){validateCurrentFilmClips(job,clips);await verifyCurrentFilmMedia(job,artifactRoot);}process.stdout.write('verified');}catch{process.stderr.write('Invalid current-film checkpoint, recorded bytes or actual source/final frame clock.');process.exitCode=1;}"
        verify_assembly_metadata({"artifactRoot":str((root/"artifacts").resolve()),"items":current_payload},code,12,"current-film media")
    if mixed_payload: verify_current_film_mixed_media(root,mixed_payload)

def editorial16_contexts(state,jobs,collect=True):
    # Detection is not ownership. Callers must run full schema16 validateSnapshot
    # before interpreting any returned receipt or its filesystem namespace.
    found=False; sources={}; nodes=0
    def visit(value,depth=0):
        nonlocal found,nodes
        nodes+=1
        if depth>220 or nodes>5_000_000: raise ValueError("mixed editorial recovery exceeds its traversal limit")
        if isinstance(value,list):
            for item in value: visit(item,depth+1)
        elif isinstance(value,dict):
            marker=value.get("schema")
            if marker in ("hv-edit-library/2","hv-edit-source/4"): found=True
            if collect and marker in ("hv-edit-source/1","hv-edit-source/2","hv-edit-source/3","hv-edit-source/4"):
                revision=value.get("revision")
                if not isinstance(revision,str) or not re.fullmatch(r"[a-f0-9]{64}",revision): raise ValueError("invalid retained editorial receipt identity")
                if revision in sources and sources[revision]!=value: raise ValueError("retained editorial receipt bodies conflict")
                sources[revision]=value
            for item in value.values(): visit(item,depth+1)
    visit(state); visit(jobs)
    return found,list(sources.values())

def source16_records(source,project):
    original=source.get("job",{}); records=source.get("files")
    if original.get("projectId")!=project or not isinstance(original.get("id"),str) or not ID.fullmatch(original["id"]): raise ValueError("editorial source escaped its original job")
    if not isinstance(records,list) or not 1<=len(records)<=30000: raise ValueError("invalid editorial source inventory")
    seen=set()
    for record in records:
        if not isinstance(record,dict): raise ValueError("invalid editorial source file")
        key=record.get("path"); safe_path("artifacts/"+key if isinstance(key,str) else key,project)
        if key in seen or not key.startswith(project+"/"+original["id"]+"/"): raise ValueError("editorial source escaped or repeated its original role")
        # /4 never inherits the separately measured top-level/preview MP4 allowance.
        if type(record.get("bytes")) is not int or not 0<record["bytes"]<=MAX_FILE_BYTES or not isinstance(record.get("sha256"),str) or not re.fullmatch(r"[a-f0-9]{64}",record["sha256"]): raise ValueError("invalid editorial source file metadata")
        seen.add(key)
    return records

def nested_source16_carriers(sources,jobs,carriers,project):
    # Metadata-only composition after exact TS ownership. Never append nested Jobs
    # to the top-level queue or pretend the original preview is the current owner.
    by_revision={source["revision"]:source for source in sources}; queue=[]; seen=set(); result=[]; copies_seen=0; edges=0
    def enqueue(owner,source,copies,inventory,depth):
        nonlocal copies_seen,edges
        edges+=1
        if depth>220 or len(seen)>=100000 or edges>5_000_000: raise ValueError("nested source carrier mapping exceeds its traversal limit")
        expected=by_revision.get(source.get("revision"))
        if expected!=source: raise ValueError("nested carrier changed its exact owned receipt")
        originals=source16_records(source,project)
        if not isinstance(copies,list) or len(copies)!=len(originals): raise ValueError("nested source carrier lost complete originals")
        index={item["path"]:item for item in inventory}
        if len(index)!=len(inventory): raise ValueError("nested source carrier inventory repeats a path")
        for original,copy in zip(originals,copies):
            owned=copy.get("copy",{})
            if copy.get("original")!=original or owned.get("sha256")!=original["sha256"] or owned.get("bytes")!=original["bytes"] or index.get(owned.get("path"))!=owned: raise ValueError("nested source carrier changed its complete copy mapping")
            safe_path("artifacts/"+owned["path"],project)
            if not owned["path"].startswith(project+"/"+owner["id"]+"/"): raise ValueError("nested source carrier escaped its actual owner")
        token=hashlib.sha256(json.dumps([owner["id"],source["revision"],copies],sort_keys=True,separators=(",",":"),allow_nan=False).encode()).digest()
        if token in seen: return False
        copies_seen+=len(copies)
        if copies_seen>5_000_000: raise ValueError("nested source carrier copies exceed their traversal limit")
        seen.add(token); queue.append((owner,source,copies,depth)); return True
    for owner,retained,inventory in carriers:
        enqueue(owner,retained["receipt"],retained.get("copies"),inventory,0)
    for source in sources:
        original=source["job"]; current=next((job for job in jobs if job.get("id")==original["id"]),None)
        # The exact snapshot validator checks conflicting same-ID historical scopes.
        # Keep the original candidate's historical output identity unchanged.
        if current and current.get("output")==original.get("output") and current.get("graphicOutput")==original.get("graphicOutput"):
            files=source16_records(source,project)
            enqueue(current,source,[{"original":file,"copy":file} for file in files],files,0)
    for owner,source,copies,depth in queue:
        if source.get("schema")!="hv-edit-source/4": continue
        translated={copy["original"]["path"]:copy for copy in copies}
        nested=mixed_original_carriers([source["job"]],project)+proof_original_carriers([source["job"]],project)
        for _,retained,inventory in nested:
            child=[]
            for copy in retained["copies"]:
                parent=translated.get(copy["copy"]["path"])
                if not parent or parent["original"]!=copy["copy"]: raise ValueError("nested proof lost a complete parent receipt role")
                child.append({"original":copy["original"],"copy":parent["copy"]})
            owned=[copy["copy"] for copy in child]
            entry=(owner,{"receipt":retained["receipt"],"copies":child},owned)
            if enqueue(owner,retained["receipt"],child,owned,depth+1): result.append(entry)
    return result

@contextmanager
def source16_probe():
    path=Path(tempfile.mkdtemp(prefix="hv-receipt-verify-")).resolve(); identity=path.lstat()
    def owned():
        current=path.lstat()
        if stat.S_ISLNK(current.st_mode) or not stat.S_ISDIR(current.st_mode) or (current.st_dev,current.st_ino)!=(identity.st_dev,identity.st_ino) or path.resolve()!=path: raise ValueError("receipt probe scratch changed identity; preserved for review")
    try: yield path
    finally:
        owned()
        with os.scandir(path) as directory:
            first=next(directory,None); second=next(directory,None)
        if second or first and first.name!="picture-probe.json": raise ValueError("receipt probe scratch has an unowned role; preserved for review")
        if first:
            file=path/first.name; info=file.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size>1024**2 or file.resolve()!=file: raise ValueError("receipt probe scratch role changed; preserved for review")
            owned(); file.unlink()
        owned(); path.rmdir()

def verify_source16_media(items):
    # One exact receipt per existing bounded subprocess operation. Scratch is new,
    # empty and owned by this invocation; the helper permits one <=1 MiB probe role.
    module=(Path(__file__).resolve().parent/"verify-edit-source-receipt-archive.ts").as_uri()
    code="import {verifyEditSourceReceiptArchive} from "+json.dumps(module)+";try{const {receipt,artifactRoot,probeScratch}=await Bun.stdin.json();await verifyEditSourceReceiptArchive(receipt,artifactRoot,probeScratch);process.stdout.write('verified');}catch{process.stderr.write('Invalid retained mixed editorial receipt, ordered delivery, native proof or measured facts.');process.exitCode=1;}"
    for item in items:
        with source16_probe() as scratch:
            verify_assembly_metadata({**item,"probeScratch":str(scratch)},code,16,"mixed editorial original media")

def verify_source16_conforms(root,jobs):
    # Hashes alone cannot prove canonical 22050->48000 source conversion or conform.
    # Verify each actual stored checkpoint/output that contains /4, including assembly.
    repository=Path(__file__).resolve().parent.parent
    edit=(repository/"packages/generator/src/edit-media.ts").as_uri()
    assembly=(repository/"packages/generator/src/edit-assembly-media.ts").as_uri()
    code="import {verifyEditMedia} from "+json.dumps(edit)+";import {verifyEditAssemblyMedia} from "+json.dumps(assembly)+";try{const {job,output,kind,artifactRoot}=await Bun.stdin.json();if(kind==='editorial')await verifyEditMedia(job,output,artifactRoot,async()=>{});else if(kind==='assembly')await verifyEditAssemblyMedia(job,output,artifactRoot,async()=>{});else throw Error('kind');process.stdout.write('verified');}catch{process.stderr.write('Invalid retained mixed editorial source conversion, conform or delivered media.');process.exitCode=1;}"
    seen=set()
    for job in jobs:
        for field,kind in (("editCheckpoint","editorial"),("assemblyCheckpoint","assembly"),("output","editorial"),("output","assembly")):
            output=job.get(field); result=output.get(kind) if isinstance(output,dict) else None
            if not isinstance(result,dict): continue
            _,sources=editorial16_contexts({},[result])
            if not any(source.get("schema")=="hv-edit-source/4" for source in sources): continue
            token=hashlib.sha256(json.dumps([job["id"],kind,output],sort_keys=True,separators=(",",":"),allow_nan=False).encode()).digest()
            if token in seen: continue
            seen.add(token)
            verify_assembly_metadata({"job":job,"output":output,"kind":kind,"artifactRoot":str((root/"artifacts").resolve())},code,16,"mixed editorial conversion and conform")


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
    if schema not in ("hv-state/1","hv-state/2","hv-state/3","hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16") or ("lipSyncAttempts" in ledger or any(job.get("stage")=="lip-sync" for job in jobs)) and schema=="hv-state/1":
        raise ValueError("lip-sync recovery requires state schema 2")
    if editorial16_contexts(state,jobs,False)[0] and schema!="hv-state/16": raise ValueError("mixed editorial source recovery requires state schema 16")
    pending_jobs,pending_decisions,pending_sources=pending_script_contexts(state,jobs)
    current_sources=current_film_sources(state,jobs)
    if current_film_proof_contexts(state,jobs) and schema not in ("hv-state/15","hv-state/16"): raise ValueError("prepared current-film proof recovery requires state schema 15")
    if current_film_mixed_contexts(state,jobs) and schema not in ("hv-state/14","hv-state/15","hv-state/16"): raise ValueError("mixed current-film recovery requires state schema 14")
    if current_sources and schema not in ("hv-state/13","hv-state/14","hv-state/15","hv-state/16"): raise ValueError("retained current-film source recovery requires state schema 13")
    if current_screenplay_contexts(state,jobs) and schema not in ("hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16"): raise ValueError("current screenplay recovery requires state schema 12")
    if execution_contexts(state,jobs) and schema not in ("hv-state/11","hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16"): raise ValueError("private shot execution recovery requires state schema 11")
    if (pending_jobs or pending_decisions) and schema not in ("hv-state/10","hv-state/11","hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16"): raise ValueError("pending screenplay jobs and preview decisions require state schema 10")
    assemblies=assembly_state(state["projects"][0])
    living_script=living_script_state(state["projects"][0])
    living_acceptances=living_script_acceptances_state(state["projects"][0])
    if living_acceptances and schema not in ("hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16"): raise ValueError("linked screenplay acceptance recovery requires state schema 9")
    if living_script and schema not in ("hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16"): raise ValueError("living screenplay proposal recovery requires state schema 8")
    assembly_jobs=[job for job in jobs if job.get("stage")=="assembly-edit" or "assemblyEdit" in job or "assemblyCheckpoint" in job or isinstance(job.get("output"),dict) and "assembly" in job["output"]]
    if (assemblies or assembly_jobs) and schema not in ("hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16"): raise ValueError("alternate assembly recovery requires state schema 7")
    if schema=="hv-state/7" and "assemblyLibrary" in state["projects"][0] and not assembly_jobs: verify_assembly_planner(state["projects"][0])
    if schema not in ("hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16") and composite_state(state["projects"][0],jobs): raise ValueError("authored mask and matte recovery requires state schema 6")
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
    if schema in ("hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16"):
        verify_current_screenplay(state,jobs,ledger,reviews,int(schema.split("/")[1]))
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
    # Full TS ownership has succeeded before any /4 receipt path or carrier is used.
    source16=editorial16_contexts(state,jobs)[1] if schema=="hv-state/16" else []
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
    if schema not in ("hv-state/3","hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16") and ("soundLibrary" in state["projects"][0] or any(job.get("stage")=="sound-mix" or "soundMix" in job for job in jobs)): raise ValueError("sound recovery requires state schema 3")
    editorial=state["projects"][0].get("editLibrary")
    edit_jobs=[job for job in jobs if job.get("stage")=="picture-edit" or "pictureEdit" in job or "editCheckpoint" in job or "editorial" in job.get("output",{})]
    if (editorial is not None or edit_jobs) and schema not in ("hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16"): raise ValueError("editorial recovery requires state schema 4")
    if schema not in ("hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13","hv-state/14","hv-state/15","hv-state/16") and ("graphicLibrary" in state["projects"][0] or any(job.get("stage")=="motion-graphic" or "graphicRender" in job or "graphicOutput" in job or "graphicCheckpoint" in job for job in jobs)): raise ValueError("graphic recovery requires state schema 5")
    edit_sources=(list(pending_sources) if pending_jobs else [])+current_sources
    for job in jobs+([source["job"] for source in current_sources] if schema in ("hv-state/14","hv-state/15","hv-state/16") else []):
        if "currentFilm" in job:
            original=job["currentFilm"].get("library",{}).get("origin",{}).get("request",{}).get("source")
            if not isinstance(original,dict): raise ValueError("current film lost its historical bootstrap original")
            edit_sources.append(original)
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
        if not isinstance(editorial,dict) or editorial.get("schema") not in (("hv-edit-library/1","hv-edit-library/2") if schema=="hv-state/16" else ("hv-edit-library/1",)) or not isinstance(editorial.get("sources"),list) or len(editorial["sources"])>64:
            raise ValueError("invalid editorial source library")
        edit_sources.extend(editorial["sources"])
    carriers=mixed_original_carriers(jobs,project)+proof_original_carriers(jobs,project)
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
    if schema=="hv-state/16":
        # Includes generic frozen/abandoned editorial histories already validated
        # by TS, without filtering an unrelated /4 out of a legacy proposal.
        edit_sources=source16
        carriers+=nested_source16_carriers(source16,jobs,carriers,project)
    # A pending plan names an exact historical carrier, not an interchangeable path.
    # The full Bun validator binds its metadata; byte custody must retain that mapping.
    proof_pending=proof_owned_pending_jobs(jobs+([source["job"] for source in source16 if source.get("schema")=="hv-edit-source/4"] if schema=="hv-state/16" else []))
    for pending_job in pending_jobs:
        # The exact nested historical job is independently covered by prepared
        # proof media plus the closure's original copies, not its expired carrier.
        # Top-level unmarked pending jobs retain their existing carrier contract.
        if all(pending_job is not job for job in jobs) and json.dumps(pending_job,sort_keys=True,separators=(",",":")) in proof_pending: continue
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
        if ("livingScript" not in job and "executionCheckpoints" not in job and "currentFilm" not in job) or job.get("status")!="done": continue
        # The schema-14 bridge above verifies the exact row/origin/output inventory,
        # full final clock and delivery. V3 has no legacy output.records projection.
        if mixed_current_film(job): continue
        output=job.get("output")
        if not isinstance(output,dict): raise ValueError("pending screenplay lost its completed film")
        records=output.get("currentFilm",{}).get("records") if "currentFilm" in job else output.get("shotRenders")
        if not isinstance(records,list): raise ValueError("pending screenplay lost its completed film")
        for row in records:
            shot=row.get("record") if "currentFilm" in job and isinstance(row,dict) else row
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
    verified_current_sources={}; verified_mixed_sources={}
    for source in edit_sources:
        if not isinstance(source,dict): raise ValueError("invalid editorial source")
        original=source.get("job",{})
        if original.get("projectId")!=project or not isinstance(original.get("id"),str) or not ID.fullmatch(original["id"]): raise ValueError("editorial source escaped its original job")
        if not isinstance(source.get("files"),list) or not 1<=len(source["files"])<=30000: raise ValueError("invalid editorial source inventory")
        if schema=="hv-state/16": source16_records(source,project)
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
            if intact and source.get("schema") in ("hv-edit-source/3","hv-edit-source/4"):
                # validatePreparedEditSources fixes this exact original-path suffix for
                # every role. Check it again before choosing a filesystem verification root.
                prefixes=set()
                for original_file,copied in zip(source["files"],records):
                    original_path=original_file["path"]; copied_path=copied["path"]
                    if not copied_path.endswith(original_path): raise ValueError("current-film source copy changed its original path")
                    prefix=copied_path[:-len(original_path)]
                    if prefix and not prefix.endswith("/"): raise ValueError("invalid current-film source copy namespace")
                    prefixes.add(prefix)
                if len(prefixes)!=1: raise ValueError("current-film source copies lost their shared namespace")
                namespace=next(iter(prefixes)); media_root=(root/"artifacts"/namespace).resolve()
                if not media_root.is_relative_to((root/"artifacts").resolve()): raise ValueError("current-film source escaped its artifact root")
                if source.get("schema")=="hv-edit-source/4": verified_mixed_sources[source["revision"]]={"receipt":source,"artifactRoot":str(media_root)}
                else: verified_current_sources[source["revision"]]={"job":original,"artifactRoot":str(media_root)}
        if not available: raise ValueError("archive editorial source is missing or corrupt")
    if verified_current_sources: verify_current_source_media(list(verified_current_sources.values()))
    if verified_mixed_sources: verify_source16_media(list(verified_mixed_sources.values()))
    # Original custody alone does not retain the derived waveforms, source manifest or
    # delivered picture. Check every sealed file in completed and checkpoint-only edits.
    for job in edit_jobs:
        for field in ("editCheckpoint","output"):
            output=job.get(field)
            if output is None: continue
            result=output.get("editorial") if isinstance(output,dict) else None
            records=result.get("files") if isinstance(result,dict) else None
            if not isinstance(records,list) or not 1<=len(records)<=80000 or any(not isinstance(record,dict) or not isinstance(record.get("path"),str) for record in records) or len({record["path"] for record in records})!=len(records): raise ValueError("invalid editorial inventory")
            for record in records:
                key=record["path"]; safe_path("artifacts/"+key,project)
                if not key.startswith(project+"/"+job["id"]+"/"): raise ValueError("editorial escaped its owner")
                if type(record.get("bytes")) is not int or not 0<record["bytes"]<=MAX_FILE_BYTES or not isinstance(record.get("sha256"),str) or not re.fullmatch(r"[a-f0-9]{64}",record["sha256"]): raise ValueError("invalid editorial file metadata")
                path=root/"artifacts"/key
                if any(part.is_symlink() for part in (path,*path.parents)): raise ValueError("editorial links are forbidden")
                if not path.is_file() or path.stat().st_size!=record["bytes"] or digest(path)!=record["sha256"]: raise ValueError("archive editorial is missing or corrupt")
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
    if schema=="hv-state/16": verify_source16_conforms(root,edit_jobs+assembly_jobs)
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
def large_current_film_outputs(schema,jobs,project):
    # Whole-snapshot validation precedes this narrow size exception. Original
    # media and every other role retain 8 GiB; the archive total stays 64 GiB.
    if schema not in ("hv-state/14","hv-state/15","hv-state/16"): return {}
    result={}
    def add(job,key,video):
        if type(video.get("bytes")) is not int or video["bytes"]<=MAX_FILE_BYTES: return
        safe_path("artifacts/"+key if isinstance(key,str) else key,project)
        if video["bytes"]>MAX_TOTAL_BYTES or not key.startswith(project+"/"+job["id"]+"/") or not re.fullmatch(r"[a-f0-9]{64}",str(video.get("sha256"))): raise ValueError("invalid measured large mixed-film output")
        name="artifacts/"+key
        if name in result: raise ValueError("duplicate large mixed-film output")
        result[name]=video
    for job in jobs:
        if not mixed_current_film(job): continue
        output=job.get("output",{}); current=output.get("currentFilm",{})
        if job.get("status")=="done" and current.get("schema")=="hv-current-film-output/3": add(job,output.get("mp4Path"),current.get("assembly",{}).get("video",{}))
        proof=job.get("currentFilmProof",{}).get("specification",{}) if schema in ("hv-state/15","hv-state/16") else {}
        context={item["id"]:item for item in proof.get("frozenContext",{}).get("jobs",[])}
        for group in proof.get("previews",[]):
            preview=context.get(group["jobId"],{}); delivery=preview.get("output",{}); rendered=delivery.get("currentFilm",{}); video=rendered.get("assembly",{}).get("video",{})
            if rendered.get("schema") not in ("hv-current-film-output/2","hv-current-film-output/3"): continue
            for copy in group["copies"]:
                original=copy["original"]; owned=copy["owned"]
                if original.get("path")!=delivery.get("mp4Path"): continue
                if original.get("bytes")!=video.get("bytes") or original.get("sha256")!=video.get("sha256") or owned.get("bytes")!=video.get("bytes") or owned.get("sha256")!=video.get("sha256"): raise ValueError("large proof preview changed its measured original")
                add(job,owned.get("path"),video)
    return result

def archive_file_size(name,size,large,sha256=None):
    if type(size) is not int or size<0: return False
    if size<=MAX_FILE_BYTES: return True
    expected=large.get(name)
    return bool(expected and size==expected["bytes"] and size<=MAX_TOTAL_BYTES and (sha256 is None or sha256==expected["sha256"]))

def pack(source, output, project):
    source, output = source.resolve(),output.resolve()
    if output.exists() or output.is_relative_to(source): raise ValueError("archive output must be new and outside the source")
    jobs=project_scope(source,project)
    large=large_current_film_outputs(json.loads((source/"snapshot.json").read_text())["schema"],jobs,project)
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
            if not archive_file_size(relative,size,large) or total>MAX_TOTAL_BYTES or len(files)>=MAX_FILES: raise ValueError("archive exceeds its size or file limit")
            sha256=digest(path)
            if not archive_file_size(relative,size,large,sha256): raise ValueError("large mixed-film output changed its recorded digest")
            files.append({"path":relative,"bytes":size,"sha256":sha256})
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
        if info.file_size>MAX_TOTAL_BYTES or info.flag_bits&1 or info.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED):
            raise ValueError("unsupported or excessive archive entry")
        if stat.S_IFMT(info.external_attr>>16) not in (0,stat.S_IFREG): raise ValueError("archive links and special files are forbidden")
        if info.file_size>max(1,info.compress_size)*200: raise ValueError("archive compression ratio exceeds its limit")
    if sum(info.file_size for info in infos)>MAX_TOTAL_BYTES+MAX_MANIFEST_BYTES: raise ValueError("archive exceeds its expanded size limit")
    manifest=json.loads(archive.read(manifests[0]))
    if not isinstance(manifest,dict): raise ValueError("invalid archive manifest")
    project=manifest.get("projectId")
    if manifest.get("schema")!=SCHEMA or not isinstance(project,str) or not ID.fullmatch(project) or not isinstance(manifest.get("files"),list):
        raise ValueError("unsupported project archive")
    large={}
    # Inspect all bounded state metadata before creating an extraction directory.
    # A downgraded marker must not depend on a large-file exception to be seen.
    if not STATE_FILES.issubset({info.filename for info in infos}): raise ValueError("archive state is incomplete")
    snapshot=json.loads(archive.read("snapshot.json"))
    if not isinstance(snapshot,dict): raise ValueError("invalid archive snapshot metadata")
    state=json.loads(archive.read("state/projects.json")); jobs=json.loads(archive.read("queue/jobs.json")); ledger=json.loads(archive.read("state/cost-ledger.json")); reviews=json.loads(archive.read("state/operator-review-queue.json"))
    if editorial16_contexts([snapshot,state,ledger,reviews],jobs,False)[0] and snapshot.get("schema")!="hv-state/16":
        raise ValueError("mixed editorial source recovery requires state schema 16 before extraction")
    # These metadata files contain no supported source/library owner locations.
    # Passing only snapshot.schema or invoking domain validation cannot confer
    # ownership on a marker hidden in an envelope, ledger or review record.
    if editorial16_contexts([snapshot,ledger,reviews],[],False)[0]:
        raise ValueError("mixed editorial source marker has no owner in this archive metadata")
    if snapshot.get("schema")=="hv-state/16" or any(info.file_size>MAX_FILE_BYTES for info in infos):
        # Validate bounded metadata before writing any expanded large file. Only
        # schema14's exact measured final MP4 can exceed the historical role limit.
        # State16 also proves every receipt/library ownership path before any
        # expanded bytes are written; retained /4 files still have the old cap.
        if not STATE_FILES.issubset({info.filename for info in infos}): raise ValueError("archive state is incomplete")
        if snapshot.get("schema") not in ("hv-state/14","hv-state/15","hv-state/16"): raise ValueError("unsupported or excessive archive entry")
        verify_current_screenplay(state,jobs,ledger,reviews,int(snapshot["schema"].split("/")[1]))
        large=large_current_film_outputs(snapshot["schema"],jobs,project)
    if any(not archive_file_size(info.filename,info.file_size,large) for info in infos): raise ValueError("unsupported or excessive archive entry")
    expected={}
    for entry in manifest["files"]:
        if not isinstance(entry,dict): raise ValueError("invalid archive file metadata")
        name=entry.get("path")
        safe_path(name,project)
        if name in expected or not archive_file_size(name,entry.get("bytes"),large,entry.get("sha256")) or not re.fullmatch(r"[a-f0-9]{64}",str(entry.get("sha256"))):
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
