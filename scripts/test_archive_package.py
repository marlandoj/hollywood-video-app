import copy, hashlib, importlib.util, json, os, re, shutil, stat, subprocess, sys, tempfile, unittest, warnings, zipfile
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location("archive_package",Path(__file__).with_name("archive-package.py"))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
STATE_PATHS=("state/projects.json","queue/jobs.json","state/cost-ledger.json","state/operator-review-queue.json")

def write_snapshot(root,schema):
    """Write the hv-state manifest the TypeScript reader has always required: schema plus a digest map."""
    files={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in STATE_PATHS}
    (root/"snapshot.json").write_text(json.dumps({"schema":schema,"files":files}))

def write_state(root,parts,schema):
    for name,body in parts.items():
        path=root/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(body))
    write_snapshot(root,schema)

class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.source=self.root/"source"; self.source.mkdir()
        parts={"state/projects.json":{"version":1,"projects":[{"id":"project-one"}],"reviewLinks":[],"takenDown":[],"takedownLog":[]},
            "queue/jobs.json":[{"id":"job-one","projectId":"project-one","status":"done"}],
            "state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[]}
        write_state(self.source,parts,"hv-state/1")
        self.media=self.source/"artifacts/project-one/job-one/film.mp4"; self.media.parent.mkdir(parents=True); self.media.write_bytes(b"verified-media"*200)
        self.archive=self.root/"project.hv.zip"; module.pack(self.source,self.archive,"project-one")
    def rewrite(self,mutation):
        with zipfile.ZipFile(self.archive) as archive: entries=[(info,archive.read(info))for info in archive.infolist()]
        entries=mutation(entries)
        with warnings.catch_warnings(),zipfile.ZipFile(self.archive,"w") as archive:
            warnings.simplefilter("ignore",UserWarning)
            for info,body in entries: archive.writestr(info,body)
    def rejected(self):
        with self.assertRaises((ValueError,zipfile.BadZipFile)):
            module.unpack(self.archive,self.root/"restored")
        self.assertFalse((self.root/"restored").exists())
        self.assertEqual(list(self.root.glob("restored.*.pending")),[])
    def test_round_trip_checksums_private_permissions_and_no_overwrite(self):
        receipt=module.unpack(self.archive,self.root/"restored")
        self.assertEqual(receipt["files"],6)
        for path in self.source.rglob("*"):
            if path.is_file(): self.assertEqual(path.read_bytes(),(self.root/"restored"/path.relative_to(self.source)).read_bytes())
        if os.name!="nt": self.assertEqual(stat.S_IMODE(self.archive.stat().st_mode),0o600)
        with self.assertRaises(ValueError): module.pack(self.source,self.archive,"project-one")
        with self.assertRaises(ValueError): module.unpack(self.archive,self.root/"restored")
    def test_duplicate_entry(self):
        self.rewrite(lambda entries:entries+[entries[-1]]); self.rejected()
    def test_audio_hold_scope_and_archive_round_trip(self):
        path=self.source/"state/cost-ledger.json"
        attempt={"id":"attempt-one","jobId":"job-one","projectId":"project-one","status":"unknown","estimatedUsd":0.25,"actualUsd":None}
        hold={"jobId":"job-one","stage":"audio-take","amountUsd":0.25,"remainingUsd":0.25}
        ledger={"events":[],"audioAttempts":[attempt],"reservations":[hold]}
        path.write_text(json.dumps(ledger)); archive=self.root/"audio.zip"; module.pack(self.source,archive,"project-one")
        target=self.root/"audio-restored"; module.unpack(archive,target)
        self.assertEqual(json.loads((target/"state/cost-ledger.json").read_text()),ledger)
        for bad in [
            {**ledger,"reservations":[]},
            {**ledger,"reservations":[{**hold,"remainingUsd":0}]},
            {**ledger,"reservations":[None]},
            {**ledger,"audioAttempts":[{**attempt,"projectId":"foreign"}]},
            {**ledger,"audioAttempts":[attempt,attempt]},
        ]:
            path.write_text(json.dumps(bad))
            with self.assertRaises(ValueError): module.project_scope(self.source,"project-one")
    def test_unlisted_traversal(self):
        self.rewrite(lambda entries:entries+[("../escaped",b"bad")]); self.rejected()
        self.assertFalse((self.root/"escaped").exists())
    def test_lipsync_schema_and_unresolved_hold_round_trip(self):
        path=self.source/"state/cost-ledger.json"
        attempt={"id":"lip-attempt","jobId":"job-one","projectId":"project-one","status":"unknown","estimatedUsd":5,"actualUsd":None}
        hold={"jobId":"job-one","stage":"lip-sync","amountUsd":5,"remainingUsd":5}
        ledger={"events":[],"lipSyncAttempts":[attempt],"reservations":[hold]}
        path.write_text(json.dumps(ledger))
        with self.assertRaisesRegex(ValueError,"schema 2"): module.project_scope(self.source,"project-one")
        write_snapshot(self.source,"hv-state/2")
        archive=self.root/"lip.zip"; module.pack(self.source,archive,"project-one")
        target=self.root/"lip-restored"; module.unpack(archive,target)
        self.assertEqual(json.loads((target/"state/cost-ledger.json").read_text()),ledger)
        for bad in [{**ledger,"reservations":[]},{**ledger,"reservations":[{**hold,"stage":"audio-take"}]},{**ledger,"lipSyncAttempts":[{**attempt,"projectId":"foreign"}]},{**ledger,"audioAttempts":[attempt]}]:
            path.write_text(json.dumps(bad))
            with self.assertRaises(ValueError): module.project_scope(self.source,"project-one")
    def test_manifest_traversal(self):
        def mutate(entries):
            manifest=json.loads(entries[0][1]); manifest["files"][0]["path"]="../escaped"
            return [(entries[0][0],json.dumps(manifest).encode())]+entries[1:]
        self.rewrite(mutate); self.rejected()
    def test_symlink(self):
        def mutate(entries):
            entries[-1][0].external_attr=(stat.S_IFLNK|0o777)<<16
            return entries
        self.rewrite(mutate); self.rejected()
    def test_corrupted_content_and_partial_cleanup(self):
        self.rewrite(lambda entries:entries[:-1]+[(entries[-1][0],b"x"*len(entries[-1][1]))]); self.rejected()
    def test_expanded_size_limit(self):
        with patch.object(module,"MAX_TOTAL_BYTES",1),patch.object(module,"MAX_MANIFEST_BYTES",2048): self.rejected()
    def test_compression_bomb(self):
        def mutate(entries):
            info=zipfile.ZipInfo("bomb"); info.compress_type=zipfile.ZIP_DEFLATED
            return entries+[(info,b"0"*1000000)]
        self.rewrite(mutate); self.rejected()
    def test_cross_project_operator_review(self):
        (self.source/"state/operator-review-queue.json").write_text('[{"projectId":"another"}]')
        with self.assertRaisesRegex(ValueError,"another project"): module.pack(self.source,self.root/"bad.zip","project-one")
    def test_unknown_job_media(self):
        path=self.source/"artifacts/project-one/unknown/file"; path.parent.mkdir(); path.write_bytes(b"bad")
        with self.assertRaisesRegex(ValueError,"unknown job"): module.pack(self.source,self.root/"bad.zip","project-one")
    def test_source_symlink(self):
        try: (self.media.parent/"link").symlink_to(self.media)
        except OSError as error:
            if os.name=="nt" and getattr(error,"winerror",None)==1314: self.skipTest("Windows symlink creation privilege is unavailable; exercised in Linux CI")
            raise
        with self.assertRaisesRegex(ValueError,"links|regular"): module.pack(self.source,self.root/"bad.zip","project-one")
    def test_invalid_manifest_type(self):
        self.rewrite(lambda entries:[(entries[0][0],b"[]")]+entries[1:]); self.rejected()
    def reference(self):
        body=b"normalized-fictional-raster"; hashed=hashlib.sha256(body).hexdigest()
        path=self.source/"artifacts/project-one/references/reference-one"/(hashed+".png"); path.parent.mkdir(parents=True); path.write_bytes(body)
        state_path=self.source/"state/projects.json"; state=json.loads(state_path.read_text())
        state["projects"][0]["referenceAssets"]=[{"id":"reference-one","projectId":"project-one","sha256":hashed,"bytes":len(body)}]
        state_path.write_text(json.dumps(state)); return path
    def test_reference_round_trip_and_index_integrity(self):
        path=self.reference(); archive=self.root/"references.zip"; module.pack(self.source,archive,"project-one")
        restored=self.root/"reference-restored"; module.unpack(archive,restored)
        self.assertEqual(path.read_bytes(),(restored/path.relative_to(self.source)).read_bytes())
        path.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError,"reference is missing or corrupt"): module.pack(self.source,self.root/"bad.zip","project-one")
    def test_missing_or_unindexed_reference(self):
        path=self.reference(); path.unlink()
        with self.assertRaisesRegex(ValueError,"reference is missing or corrupt"): module.pack(self.source,self.root/"bad.zip","project-one")
        path.write_bytes(b"normalized-fictional-raster"); (path.parent/"unknown.png").write_bytes(b"unknown")
        with self.assertRaisesRegex(ValueError,"unindexed reference"): module.pack(self.source,self.root/"bad.zip","project-one")
    def test_invalid_reference_metadata(self):
        state_path=self.source/"state/projects.json"; state=json.loads(state_path.read_text()); state["projects"][0]["referenceAssets"]=[[]]
        state_path.write_text(json.dumps(state))
        with self.assertRaisesRegex(ValueError,"invalid reference catalog"): module.pack(self.source,self.root/"bad.zip","project-one")


class EditorialScopeTests(unittest.TestCase):
    def test_composite_archive_preserves_abandoned_branches_and_requires_schema_six(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/"source"; root.mkdir()
            # Archive qualification checks custody and the compatibility gate;
            # the TypeScript restore separately validates and replays full histories.
            history={"root":{"schema":"hv-edit-timeline/1","clips":[]},"events":[{"kind":"edit","operation":{"kind":"composite","clipId":"picture","composite":None}},{"kind":"cursor","target":0,"reason":"undo"}]}
            project={"id":"project","editLibrary":{"schema":"hv-edit-library/1","sources":[],"sequences":[{"history":history}]}}
            state={"version":1,"projects":[project],"reviewLinks":[],"takenDown":[],"takedownLog":[]}
            write_state(root,{"state/projects.json":state,"queue/jobs.json":[],"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[]},"hv-state/6")
            archive=Path(temporary)/"mattes.hv.zip"; target=Path(temporary)/"restored"
            module.pack(root,archive,"project"); module.unpack(archive,target)
            self.assertEqual(json.loads((target/"state/projects.json").read_text()),state)
            for schema in ("hv-state/4","hv-state/5"):
                write_snapshot(root,schema)
                with self.assertRaisesRegex(ValueError,"schema 6"): module.project_scope(root,"project")
            # Each retained location independently imposes the newer gate.
            del project["editLibrary"]; (root/"state/projects.json").write_text(json.dumps(state))
            plan={"sequence":{"history":history},"bindings":[]}
            for retained in ({"pictureEdit":plan},{"editCheckpoint":{"editorial":{"plan":plan}}},{"output":{"editorial":{"plan":plan}}}):
                job={"id":"edit","projectId":"project","status":"done",**retained}
                (root/"queue/jobs.json").write_text(json.dumps([job]))
                with self.assertRaisesRegex(ValueError,"schema 6"): module.project_scope(root,"project")
            # Older graphic-only archives retain their existing compatibility.
            (root/"queue/jobs.json").write_text("[]"); project["graphicLibrary"]={"events":[]}; (root/"state/projects.json").write_text(json.dumps(state))
            self.assertEqual(module.project_scope(root,"project"),[])

    def test_composite_gate_detects_new_noop_operations_and_rejects_malformed_collections(self):
        clean={"root":{"schema":"hv-edit-timeline/1","clips":[]},"events":[]}
        self.assertFalse(module.composite_history(clean))
        operations=[{"kind":"composite","clipId":"picture","composite":None},{"kind":"matte-only","layers":[]},{"kind":"replace","maskAction":"remove"},{"kind":"insert","clips":[{"composite":{}}]}]
        for operation in operations: self.assertTrue(module.composite_history({**clean,"events":[{"kind":"edit","operation":operation},{"kind":"cursor","target":0}]}))
        for root in ({"schema":"hv-edit-timeline/2"},{"matteOnlyLayers":[]},{"clips":[{"composite":{}}]}): self.assertTrue(module.composite_history({**clean,"root":root}))
        for history in ({**clean,"events":None},{**clean,"root":{"clips":None}},{**clean,"events":[{"kind":"edit","operation":{"kind":"insert","clips":None}}]}):
            with self.assertRaises(ValueError): module.composite_history(history)

    def test_retained_editorial_carrier_restores_without_the_original_job(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); video=b"original-performance"; checksum=hashlib.sha256(video).hexdigest()
            record={"path":"project/film/export.mp4","sha256":checksum,"bytes":len(video)}
            source={"job":{"id":"film","projectId":"project","output":{"mp4Path":record["path"]}},"files":[record]}
            copy={**record,"path":"project/edit/owned/original.mp4"}
            retained={"receipt":source,"copies":[{"original":record,"copy":copy}]}
            job={"id":"edit","projectId":"project","status":"done","stage":"picture-edit","output":{"editorial":{"prepared":{"sources":[retained]},"files":[copy]}}}
            state={"version":1,"projects":[{"id":"project","editLibrary":{"schema":"hv-edit-library/1","sources":[source]}}],"reviewLinks":[],"takenDown":[],"takedownLog":[]}
            write_state(root,{"state/projects.json":state,"queue/jobs.json":[job],"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[]},"hv-state/4")
            media=root/"artifacts"/copy["path"]; media.parent.mkdir(parents=True); media.write_bytes(video)
            self.assertEqual(module.project_scope(root,"project"),[job])
            del state["projects"][0]["editLibrary"]
            (root/"state/projects.json").write_text(json.dumps(state))
            self.assertEqual(module.project_scope(root,"project"),[job])
            write_snapshot(root,"hv-state/3")
            with self.assertRaisesRegex(ValueError,"schema 4"): module.project_scope(root,"project")
            write_snapshot(root,"hv-state/4")
            media.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.project_scope(root,"project")
            media.write_bytes(video); retained["copies"][0]["original"]={**record,"sha256":"0"*64}
            (root/"queue/jobs.json").write_text(json.dumps([job]))
            with self.assertRaisesRegex(ValueError,"differs from its original"): module.project_scope(root,"project")
            retained["copies"][0]["original"]=record; copy["path"]="project/foreign/original.mp4"
            (root/"queue/jobs.json").write_text(json.dumps([job]))
            with self.assertRaisesRegex(ValueError,"carrier job"): module.project_scope(root,"project")

    def test_editorial_sources_require_schema_four_original_jobs_and_exact_owned_media(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            video=b"retained-editorial-source"
            source_job={"id":"film","projectId":"project","status":"done","output":{"mp4Path":"project/film/export.mp4"}}
            record={"path":"project/film/export.mp4","sha256":hashlib.sha256(video).hexdigest(),"bytes":len(video)}
            state={"version":1,"projects":[{"id":"project","editLibrary":{"schema":"hv-edit-library/1","sources":[{"job":source_job,"files":[record]}]}}],"reviewLinks":[],"takenDown":[],"takedownLog":[]}
            write_state(root,{"state/projects.json":state,"queue/jobs.json":[source_job],"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[]},"hv-state/4")
            media=root/"artifacts"/record["path"]; media.parent.mkdir(parents=True); media.write_bytes(video)
            self.assertEqual(module.project_scope(root,"project"),[source_job])
            write_snapshot(root,"hv-state/3")
            with self.assertRaisesRegex(ValueError,"schema 4"): module.project_scope(root,"project")
            write_snapshot(root,"hv-state/4")
            (root/"queue/jobs.json").write_text("[]")
            with self.assertRaisesRegex(ValueError,"source job"): module.project_scope(root,"project")
            (root/"queue/jobs.json").write_text(json.dumps([source_job]))
            media.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.project_scope(root,"project")
            media.unlink()
            with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.project_scope(root,"project")
            media.write_bytes(video); record["path"]="project/another/export.mp4"
            (root/"state/projects.json").write_text(json.dumps(state))
            with self.assertRaisesRegex(ValueError,"original job"): module.project_scope(root,"project")
            record["path"]="project/film/../export.mp4"
            (root/"state/projects.json").write_text(json.dumps(state))
            with self.assertRaisesRegex(ValueError,"traversal"): module.project_scope(root,"project")

class AssemblyScopeTests(unittest.TestCase):
    def fixture(self):
        facts={"id":"original","frames":60,"width":64,"height":48,"revision":"a"*64}
        source={"revision":"b"*64,"facts":facts,"job":{"id":"original","projectId":"project","status":"done","output":{"mp4Path":"project/original/export.mp4"}}}
        parent={"sequenceId":"old-parent","historyRevision":"c"*64,"timeline":{"schema":"hv-edit-timeline/1","frames":60,"sources":[facts],"clips":[],"revision":"d"*64},"sourceReceipts":[{"sourceId":"original","receiptRevision":source["revision"]}]}
        plan={"schema":"hv-edit-assembly/1","parent":parent,"ranges":[{"id":"keep","fromFrame":10,"toFrame":30,"reason":"Keep the old parent range"}],"join":"cut","frames":20,"revision":"e"*64}
        library={"schema":"hv-edit-assembly-library/1","version":3,"proposals":[{"id":"proposal","plan":plan}],"assemblies":[{"id":"accepted-old-revision","plan":copy.deepcopy(plan)}],"revision":"f"*64}
        return {"id":"project","editLibrary":{"schema":"hv-edit-library/1","sources":[source],"sequences":[]},"assemblyLibrary":library}

    def test_assembly_scope_checks_every_frozen_parent_without_requiring_a_current_sequence(self):
        project=self.fixture(); self.assertTrue(module.assembly_state(project))
        project["assemblyLibrary"]["proposals"][0]["plan"]["ranges"]=[{"id":"later","fromFrame":40,"toFrame":60,"reason":"New proposal range"}]
        self.assertTrue(module.assembly_state(project))
        for collection in ("proposals","assemblies"):
            changed=copy.deepcopy(project); changed["assemblyLibrary"][collection][0]["plan"]["parent"]["sourceReceipts"][0]["receiptRevision"]="0"*64
            with self.assertRaisesRegex(ValueError,"owned original"): module.assembly_state(changed)
        changed=copy.deepcopy(project); changed["assemblyLibrary"]["assemblies"][0]["plan"]["parent"]["timeline"]["sources"][0]["width"]=128
        with self.assertRaisesRegex(ValueError,"owned original"): module.assembly_state(changed)
        project["editLibrary"]["sources"][0]["job"]["projectId"]="foreign"
        with self.assertRaisesRegex(ValueError,"owned original"): module.assembly_state(project)

    def test_malformed_assembly_collections_ranges_and_duration_are_never_ignored(self):
        for value in (None,[],{},False):
            project=self.fixture(); project["assemblyLibrary"]=value
            with self.assertRaises(ValueError): module.assembly_state(project)
        for key in ("proposals","assemblies"):
            for value in (None,{},False,[None]):
                project=self.fixture(); project["assemblyLibrary"][key]=value
                with self.assertRaises(ValueError): module.assembly_state(project)
        for selected in (None,[],[None],[{"id":"keep","fromFrame":True,"toFrame":2,"reason":"Bad boolean"}],[{"id":"keep","fromFrame":1.5,"toFrame":2,"reason":"Bad fraction"}],[{"id":"keep","fromFrame":30,"toFrame":30,"reason":"Empty"}],[{"id":"keep","fromFrame":0,"toFrame":61,"reason":"Outside"}]):
            project=self.fixture(); project["assemblyLibrary"]["proposals"][0]["plan"]["ranges"]=selected
            with self.assertRaises(ValueError): module.assembly_state(project)
        project=self.fixture(); project["assemblyLibrary"]["assemblies"][0]["plan"]["frames"]=21
        with self.assertRaisesRegex(ValueError,"duration"): module.assembly_state(project)

    def test_empty_assembly_library_preserves_old_schema_without_a_bun_dependency(self):
        data={"schema":"hv-edit-assembly-library/1","version":0,"proposals":[],"assemblies":[]}
        library={**data,"revision":hashlib.sha256(json.dumps(data,sort_keys=True,separators=(",",":")).encode()).hexdigest()}
        self.assertFalse(module.assembly_state({"id":"project"})); self.assertFalse(module.assembly_state({"id":"project","assemblyLibrary":library}))
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); self.write_scope(root,{"id":"project","assemblyLibrary":library},[],"hv-state/1")
            with patch.object(module,"verify_assembly_planner",side_effect=AssertionError("old snapshots must stay Python-only")):
                self.assertEqual(module.project_scope(root,"project"),[])
        library["revision"]="0"*64
        with self.assertRaisesRegex(ValueError,"seal"): module.assembly_state({"id":"project","assemblyLibrary":library})

    def write_scope(self,root,project,jobs,schema):
        write_state(root,{"state/projects.json":{"version":1,"projects":[project],"reviewLinks":[],"takenDown":[],"takedownLog":[]},"queue/jobs.json":jobs,"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[]},schema)

    def test_schema_gate_and_original_custody_include_unaccepted_and_old_accepted_parents(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); project=self.fixture(); source=project["editLibrary"]["sources"][0]; media=b"frozen-original"; record={"path":"project/original/export.mp4","bytes":len(media),"sha256":hashlib.sha256(media).hexdigest()}; source["files"]=[record]
            job=source["job"]; path=root/"artifacts"/record["path"]; path.parent.mkdir(parents=True); path.write_bytes(media)
            for schema in ("hv-state/1","hv-state/2","hv-state/3","hv-state/4","hv-state/5","hv-state/6"):
                self.write_scope(root,project,[job],schema)
                with self.assertRaisesRegex(ValueError,"schema 7"): module.project_scope(root,"project")
            self.write_scope(root,project,[job],"hv-state/7")
            # Unit-test Python custody separately; assembly-snapshots.test.ts
            # exercises this exact archive path with real sealed metadata/Bun.
            with patch.object(module,"verify_assembly_planner") as validator:
                self.assertEqual(module.project_scope(root,"project"),[job]); validator.assert_called_once_with(project)
                path.write_bytes(b"changed")
                with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.project_scope(root,"project")
                path.write_bytes(media); self.write_scope(root,project,[],"hv-state/7")
                with self.assertRaisesRegex(ValueError,"source job"): module.project_scope(root,"project")

    def test_bun_verification_uses_static_modules_json_stdin_and_fails_closed(self):
        project=self.fixture()
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],0,b"verified",b"")) as run:
            module.verify_assembly_planner(project); args,kwargs=run.call_args
            self.assertEqual(Path(args[0][0]),Path(sys.executable).resolve()); self.assertEqual(args[0][1],"--eval"); self.assertIn("edit-assembly-parent.ts",args[0][2]); self.assertNotIn("shell",kwargs); self.assertEqual(kwargs["timeout"],60)
            self.assertEqual(json.loads(kwargs["input"]),project)
        with patch.dict(os.environ,{},clear=True),patch.object(module.shutil,"which",return_value=None):
            with self.assertRaisesRegex(ValueError,"requires Bun"): module.verify_assembly_planner(project)
        with patch.dict(os.environ,{"HV_BUN_PATH":str(Path(sys.executable)/"missing")}):
            with self.assertRaisesRegex(ValueError,"executable"): module.verify_assembly_planner(project)
        for result in (subprocess.CompletedProcess([],1,b"",b"invalid"),subprocess.CompletedProcess([],0,b"wrong",b""),subprocess.CompletedProcess([],0,b"verified",b"x"*8193)):
            with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=result):
                with self.assertRaisesRegex(ValueError,"invalid sealed"): module.verify_assembly_planner(project)
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",side_effect=subprocess.TimeoutExpired("bun",60)):
            with self.assertRaisesRegex(ValueError,"could not complete"): module.verify_assembly_planner(project)

class AssemblyJobScopeTests(unittest.TestCase):
    write_scope=AssemblyScopeTests.write_scope
    def carrier_fixture(self,status="done"):
        media=b"frozen-performance"; record={"path":"project/original/export.mp4","bytes":len(media),"sha256":hashlib.sha256(media).hexdigest()}
        source={"job":{"id":"original","projectId":"project","output":{"mp4Path":record["path"]}},"files":[record]}
        copied={**record,"path":"project/assembly/retained/original.mp4"}; delivery={**record,"path":"project/assembly/conform/export.mp4"}
        result={"prepared":{"sources":[{"receipt":source,"copies":[{"original":record,"copy":copied}]}]},"files":[copied,delivery]}
        job={"id":"assembly","projectId":"project","stage":"assembly-edit","status":status,"assemblyEdit":{"bindings":[{"source":source}]},"assemblyCheckpoint":{"assembly":result}}
        if status=="done": job["output"]={"assembly":result}
        return job,media,copied,delivery

    def test_each_assembly_job_location_requires_schema_seven_even_without_library(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for retained in ({"stage":"assembly-edit"},{"assemblyEdit":{}},{"assemblyCheckpoint":{}},{"output":{"assembly":{}}}):
                job={"id":"assembly","projectId":"project","status":"cancelled",**retained}
                for schema in ("hv-state/1","hv-state/2","hv-state/3","hv-state/4","hv-state/5","hv-state/6"):
                    self.write_scope(root,{"id":"project"},[job],schema)
                    with self.assertRaisesRegex(ValueError,"schema 7"): module.project_scope(root,"project")

    def test_checkpoint_only_and_completed_assemblies_retain_original_custody_and_all_delivery_bytes(self):
        for status in ("done","failed","cancelled"):
            with self.subTest(status=status),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary); job,media,copied,delivery=self.carrier_fixture(status); self.write_scope(root,{"id":"project"},[job],"hv-state/7")
                for record in (copied,delivery):
                    path=root/"artifacts"/record["path"]; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(media)
                # Canonical seals and accounting are covered by the TypeScript
                # archive integration; these mutations target Python byte custody.
                with patch.object(module,"verify_assembly_jobs") as validator:
                    self.assertEqual(module.project_scope(root,"project"),[job]); self.assertEqual(validator.call_count,1)
                    destination=root/"artifacts"/delivery["path"]; destination.write_bytes(b"corrupt")
                    with self.assertRaisesRegex(ValueError,"assembly is missing or corrupt"): module.project_scope(root,"project")
                    destination.write_bytes(media); (root/"artifacts"/copied["path"]).unlink()
                    with self.assertRaisesRegex(ValueError,"editorial source is missing or corrupt"): module.project_scope(root,"project")

    def test_failed_assembly_without_checkpoint_still_requires_original_and_never_drops_active_jobs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); job,_,_,_=self.carrier_fixture("cancelled"); del job["assemblyCheckpoint"]; self.write_scope(root,{"id":"project"},[job],"hv-state/7")
            with patch.object(module,"verify_assembly_jobs"):
                with self.assertRaisesRegex(ValueError,"source job or retained carrier"): module.project_scope(root,"project")
            for status in ("queued","running"):
                job["status"]=status; self.write_scope(root,{"id":"project"},[job],"hv-state/7")
                with self.assertRaisesRegex(ValueError,"drained jobs"): module.project_scope(root,"project")

    def test_assembly_jobs_use_full_canonical_snapshot_and_reject_its_failure(self):
        state={"version":1,"projects":[{"id":"project"}],"reviewLinks":[],"takenDown":[],"takedownLog":[]}; jobs=[{"id":"assembly"}]; ledger={"events":[],"reservations":[],"audioAttempts":[],"lipSyncAttempts":[]}; reviews=[]
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],0,b"verified",b"")) as run:
            module.verify_assembly_jobs(state,jobs,ledger,reviews); args,kwargs=run.call_args
            self.assertIn("storage/src/snapshots.ts",args[0][2]); self.assertIn("validateSnapshot",args[0][2]); self.assertEqual(json.loads(kwargs["input"]),{"schema":"hv-state/7","projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews})
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],1,b"",b"invalid accounting")):
            with self.assertRaisesRegex(ValueError,"invalid sealed"): module.verify_assembly_jobs(state,jobs,ledger,reviews)

class LivingScriptScopeTests(unittest.TestCase):
    write_scope=AssemblyScopeTests.write_scope

    def empty(self,version=0):
        data={"schema":"hv-living-script-proposals/1","projectId":"project","version":version,"proposals":[]}
        return {**data,"revision":hashlib.sha256(json.dumps(data,sort_keys=True,separators=(",",":")).encode()).hexdigest()}

    def test_empty_proposals_preserve_legacy_without_a_bun_dependency(self):
        self.assertFalse(module.living_script_state({"id":"project"}))
        project={"id":"project","livingScriptProposals":self.empty()}
        self.assertFalse(module.living_script_state(project))
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); self.write_scope(root,project,[],"hv-state/1")
            before=(root/"state/projects.json").read_bytes()
            with patch.object(module,"verify_living_script",side_effect=AssertionError("old empty defaults must stay Python-only")):
                self.assertEqual(module.project_scope(root,"project"),[])
            self.assertEqual((root/"state/projects.json").read_bytes(),before)
        for value in (None,[],{},False,{**self.empty(),"proposals":None},{**self.empty(),"version":True},{**self.empty(),"projectId":"foreign"},{**self.empty(),"revision":"0"*64}):
            with self.assertRaises(ValueError): module.living_script_state({"id":"project","livingScriptProposals":value})

    def test_versioned_proposals_require_schema_eight_and_check_frozen_only_media(self):
        body=b"frozen-screenplay-original"; record={"path":"project/original/export.mp4","sha256":hashlib.sha256(body).hexdigest(),"bytes":len(body)}
        job={"id":"original","projectId":"project","status":"done","output":{"mp4Path":record["path"]}}
        source={"job":job,"files":[record]}; library={**self.empty(1),"proposals":[{"editorial":{"sources":[source]}}]}; project={"id":"project","livingScriptProposals":library}
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); path=root/"artifacts"/record["path"]; path.parent.mkdir(parents=True); path.write_bytes(body)
            for schema in ("hv-state/1","hv-state/2","hv-state/3","hv-state/4","hv-state/5","hv-state/6","hv-state/7"):
                self.write_scope(root,project,[job],schema)
                with self.assertRaisesRegex(ValueError,"schema 8"): module.project_scope(root,"project")
            self.write_scope(root,project,[job],"hv-state/8")
            # Separate byte-custody unit coverage; the Bun snapshot suite calls
            # the real canonical validator with sealed, measured originals.
            with patch.object(module,"verify_living_script") as verify:
                self.assertEqual(module.project_scope(root,"project"),[job]); verify.assert_called_once()
                path.write_bytes(b"changed")
                with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.project_scope(root,"project")
                path.write_bytes(body); self.write_scope(root,project,[],"hv-state/8")
                with self.assertRaisesRegex(ValueError,"source job"): module.project_scope(root,"project")
            self.write_scope(root,{"id":"project","livingScriptProposals":self.empty(1)},[],"hv-state/7")
            with self.assertRaisesRegex(ValueError,"schema 8"): module.project_scope(root,"project")

    def test_schema_eight_bridge_uses_full_snapshot_and_fails_closed(self):
        state={"version":1,"projects":[{"id":"project","livingScriptProposals":self.empty()}],"reviewLinks":[],"takenDown":[],"takedownLog":[]}; jobs=[]; ledger={"events":[],"reservations":[]}; reviews=[]
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],0,b"verified",b"")) as run:
            module.verify_living_script(state,jobs,ledger,reviews); args,kwargs=run.call_args
            self.assertIn("storage/src/snapshots.ts",args[0][2]); self.assertIn("validateSnapshot",args[0][2]); self.assertNotIn("shell",kwargs); self.assertEqual(kwargs["timeout"],60)
            self.assertEqual(json.loads(kwargs["input"]),{"schema":"hv-state/8","projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews})
        with patch.dict(os.environ,{},clear=True),patch.object(module.shutil,"which",return_value=None):
            with self.assertRaisesRegex(ValueError,"schema 8.*requires Bun"): module.verify_living_script(state,jobs,ledger,reviews)
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],1,b"",b"forged impact")):
            with self.assertRaisesRegex(ValueError,"invalid sealed screenplay proposal"): module.verify_living_script(state,jobs,ledger,reviews)

class LivingScriptAcceptanceScopeTests(unittest.TestCase):
    write_scope=AssemblyScopeTests.write_scope

    def empty(self):
        data={"schema":"hv-living-script-acceptances/1","projectId":"project","version":0,"records":[]}
        return {**data,"revision":hashlib.sha256(json.dumps(data,sort_keys=True,separators=(",",":")).encode()).hexdigest()}

    def test_empty_acceptances_preserve_legacy_without_a_bun_dependency(self):
        self.assertFalse(module.living_script_acceptances_state({"id":"project"}))
        project={"id":"project","livingScriptAcceptances":self.empty()}
        self.assertFalse(module.living_script_acceptances_state(project))
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); self.write_scope(root,project,[],"hv-state/1"); before=(root/"state/projects.json").read_bytes()
            with patch.object(module,"verify_living_script_acceptances",side_effect=AssertionError("empty legacy defaults must stay Python-only")):
                self.assertEqual(module.project_scope(root,"project"),[])
            self.assertEqual((root/"state/projects.json").read_bytes(),before)
        for value in (None,[],{},False,{**self.empty(),"records":None},{**self.empty(),"version":True},{**self.empty(),"version":1},{**self.empty(),"records":[{}]*17,"version":17},{**self.empty(),"projectId":"foreign"},{**self.empty(),"revision":"0"*64},{**self.empty(),"extra":True}):
            with self.assertRaises(ValueError): module.living_script_acceptances_state({"id":"project","livingScriptAcceptances":value})

    def test_schema_nine_custody_includes_acceptance_frozen_and_generated_sources_and_proposal_originals(self):
        def original(name):
            body=(name+"-media").encode(); record={"path":"project/"+name+"/export.mp4","sha256":hashlib.sha256(body).hexdigest(),"bytes":len(body)}
            job={"id":name,"projectId":"project","status":"done","output":{"mp4Path":record["path"]}}
            return {"job":job,"files":[record]},body
        frozen,frozen_bytes=original("frozen"); generated,generated_bytes=original("generated"); proposed,proposed_bytes=original("proposed")
        library={**self.empty(),"version":1,"records":[{"request":{"recutInput":{"library":{"sources":[frozen]},"generated":generated}}}]}
        proposals={"schema":"hv-living-script-proposals/1","projectId":"project","version":1,"proposals":[{"editorial":{"sources":[proposed]}}],"revision":"a"*64}
        project={"id":"project","livingScriptProposals":proposals,"livingScriptAcceptances":library}; jobs=[source["job"] for source in (frozen,generated,proposed)]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for source,body in ((frozen,frozen_bytes),(generated,generated_bytes),(proposed,proposed_bytes)):
                path=root/"artifacts"/source["files"][0]["path"]; path.parent.mkdir(parents=True); path.write_bytes(body)
            for schema in ("hv-state/1","hv-state/2","hv-state/3","hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8"):
                self.write_scope(root,project,jobs,schema)
                with self.assertRaisesRegex(ValueError,"schema 9"): module.project_scope(root,"project")
            self.write_scope(root,project,jobs,"hv-state/9"); before=(root/"state/projects.json").read_bytes()
            # This unit isolates custody. The real Bun suite validates sealed ledgers and media.
            with patch.object(module,"verify_living_script_acceptances") as verify,patch.object(module,"verify_living_script",side_effect=AssertionError("schema9 must use the full acceptance bridge")):
                self.assertEqual(module.project_scope(root,"project"),jobs); verify.assert_called_once()
                for source,body in ((frozen,frozen_bytes),(generated,generated_bytes),(proposed,proposed_bytes)):
                    path=root/"artifacts"/source["files"][0]["path"]; path.write_bytes(b"corrupt")
                    with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.project_scope(root,"project")
                    path.write_bytes(body)
                self.write_scope(root,project,[job for job in jobs if job["id"]!="generated"],"hv-state/9")
                with self.assertRaisesRegex(ValueError,"source job"): module.project_scope(root,"project")
            self.assertEqual((root/"state/projects.json").read_bytes(),before)

    def test_schema_nine_bridge_delegates_full_snapshot_and_fails_closed(self):
        state={"version":1,"projects":[{"id":"project","livingScriptAcceptances":self.empty()}],"reviewLinks":[],"takenDown":[],"takedownLog":[]}; jobs=[]; ledger={"events":[],"reservations":[]}; reviews=[]
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],0,b"verified",b"")) as run:
            module.verify_living_script_acceptances(state,jobs,ledger,reviews); args,kwargs=run.call_args
            self.assertIn("storage/src/snapshots.ts",args[0][2]); self.assertIn("validateSnapshot",args[0][2]); self.assertNotIn("shell",kwargs); self.assertEqual(kwargs["timeout"],60)
            self.assertEqual(json.loads(kwargs["input"]),{"schema":"hv-state/9","projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews})
        with patch.dict(os.environ,{},clear=True),patch.object(module.shutil,"which",return_value=None):
            with self.assertRaisesRegex(ValueError,"schema 9.*requires Bun"): module.verify_living_script_acceptances(state,jobs,ledger,reviews)
        for status,stdout,stderr in ((1,b"",b"forged request"),(0,b"unverified",b"")):
            with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],status,stdout,stderr)):
                with self.assertRaisesRegex(ValueError,"invalid sealed screenplay acceptance"): module.verify_living_script_acceptances(state,jobs,ledger,reviews)

class LivingScriptJobScopeTests(unittest.TestCase):
    write_scope=AssemblyScopeTests.write_scope

    def test_nested_pending_markers_and_reviews_require_schema_ten(self):
        for project,jobs in (({"id":"project"},[{"id":"pending","projectId":"project","status":"failed","livingScript":None}]),({"id":"project","retained":{"source":{"job":{"livingScript":{}}}}},[]),({"id":"project","animaticApprovals":[{"livingScriptReview":{}}]},[])):
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)
                for version in range(1,10):
                    self.write_scope(root,project,jobs,"hv-state/"+str(version))
                    with self.assertRaisesRegex(ValueError,"schema 10"): module.project_scope(root,"project")
        self.assertEqual(module.pending_script_contexts({"projects":[{"id":"project"}]},[]),([],[],[]))

    def test_schema_ten_bridge_preserves_whole_snapshot_and_fails_closed(self):
        state={"version":1,"projects":[{"id":"project"}],"reviewLinks":[],"takenDown":[],"takedownLog":[]}; jobs=[{"livingScript":{"request":{"role":"preview"}}}]; ledger={"events":[],"reservations":[]}; reviews=[]
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],0,b"verified",b"")) as run:
            module.verify_living_script_jobs(state,jobs,ledger,reviews); args,kwargs=run.call_args
            self.assertIn("storage/src/snapshots.ts",args[0][2]); self.assertIn("validateSnapshot",args[0][2]); self.assertNotIn("shell",kwargs); self.assertEqual(kwargs["timeout"],60)
            self.assertEqual(json.loads(kwargs["input"]),{"schema":"hv-state/10","projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews})
        with patch.dict(os.environ,{},clear=True),patch.object(module.shutil,"which",return_value=None):
            with self.assertRaisesRegex(ValueError,"schema 10.*requires Bun"): module.verify_living_script_jobs(state,jobs,ledger,reviews)
        for status,stdout,stderr in ((1,b"",b"forged proposal"),(0,b"wrong",b""),(0,b"verified",b"x"*8193)):
            with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],status,stdout,stderr)):
                with self.assertRaisesRegex(ValueError,"invalid sealed pending screenplay jobs"): module.verify_living_script_jobs(state,jobs,ledger,reviews)

    def test_exact_retained_carrier_mapping_keeps_original_bytes_without_original_job(self):
        body=b"original-retained-media"; old={"path":"project/original/export.mp4","sha256":hashlib.sha256(body).hexdigest(),"bytes":len(body)}; mapped={**old,"path":"project/carrier/original-copy.mp4"}
        original={"schema":"hv-edit-source/1","job":{"id":"original","projectId":"project","status":"done","output":{"mp4Path":old["path"]}},"files":[old]}
        retained={"receipt":original,"copies":[{"original":old,"copy":mapped}]}; carrier={"id":"carrier","projectId":"project","status":"done","stage":"picture-edit","output":{"editorial":{"prepared":{"sources":[retained]},"files":[mapped]}}}
        pending={"id":"pending","projectId":"project","status":"failed","livingScript":{"binding":{"owner":{"jobId":"carrier","projectId":"project"},"source":original,"files":[mapped]}}}; project={"id":"project"}
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); path=root/"artifacts"/mapped["path"]; path.parent.mkdir(parents=True); path.write_bytes(body); self.write_scope(root,project,[carrier,pending],"hv-state/10"); before=(root/"queue/jobs.json").read_bytes()
            # Unit-isolated custody checks; the Bun suite independently runs canonical seals
            # and actual decoded media through this same pack/unpack path.
            with patch.object(module,"verify_living_script_jobs") as verify:
                self.assertEqual(module.project_scope(root,"project"),[carrier,pending]); verify.assert_called_once(); self.assertFalse((root/"artifacts/project/original").exists())
                path.write_bytes(b"corrupt")
                with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.project_scope(root,"project")
                path.write_bytes(body); wrong=copy.deepcopy(pending); wrong["livingScript"]["binding"]["files"][0]["path"]="project/carrier/forged.mp4"; self.write_scope(root,project,[carrier,wrong],"hv-state/10")
                with self.assertRaisesRegex(ValueError,"mapping changed"): module.project_scope(root,"project")
                self.write_scope(root,project,[pending],"hv-state/10")
                with self.assertRaisesRegex(ValueError,"carrier job"): module.project_scope(root,"project")
                self.write_scope(root,project,[carrier,pending],"hv-state/10")
            self.assertEqual((root/"queue/jobs.json").read_bytes(),before)

class ShotExecutionScopeTests(unittest.TestCase):
    write_scope=AssemblyScopeTests.write_scope

    def test_capture_gates_include_failed_queue_nested_originals_and_abandoned_branches(self):
        for project,jobs in (({"id":"project"},[{"id":"film","projectId":"project","status":"failed","executionCheckpoints":[]}]),({"id":"project","retained":{"job":{"output":{"shotExecutions":[]}}}},[]),({"id":"project","abandoned":[{"schema":"hv-shot-execution-capture/1"}]},[])):
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)
                for version in range(1,11):
                    self.write_scope(root,project,jobs,"hv-state/"+str(version))
                    with self.assertRaisesRegex(ValueError,"schema 11"): module.project_scope(root,"project")
        self.assertEqual(module.execution_contexts({"projects":[{"id":"project"}]},[]),[])

    def test_schema_eleven_bridge_checks_whole_snapshot_and_never_accepts_failed_or_missing_validator(self):
        state={"version":1,"projects":[{"id":"project"}],"reviewLinks":[],"takenDown":[],"takedownLog":[]}; jobs=[{"executionCheckpoints":[]}]; ledger={"events":[],"reservations":[]}; reviews=[]
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],0,b"verified",b"")) as run:
            module.verify_shot_executions(state,jobs,ledger,reviews); args,kwargs=run.call_args
            self.assertIn("storage/src/snapshots.ts",args[0][2]); self.assertIn("validateSnapshot",args[0][2]); self.assertNotIn("shell",kwargs); self.assertEqual(kwargs["timeout"],60)
            self.assertEqual(json.loads(kwargs["input"]),{"schema":"hv-state/11","projects":state,"jobs":jobs,"ledger":ledger,"reviews":reviews})
        with patch.dict(os.environ,{},clear=True),patch.object(module.shutil,"which",return_value=None):
            with self.assertRaisesRegex(ValueError,"schema 11.*requires Bun"): module.verify_shot_executions(state,jobs,ledger,reviews)
        for result in (subprocess.CompletedProcess([],1,b"",b"forged capture"),subprocess.CompletedProcess([],0,b"unverified",b""),subprocess.CompletedProcess([],0,b"verified",b"x"*8193)):
            with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=result):
                with self.assertRaisesRegex(ValueError,"invalid sealed shot execution"): module.verify_shot_executions(state,jobs,ledger,reviews)
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",side_effect=subprocess.TimeoutExpired("bun",60)):
            with self.assertRaisesRegex(ValueError,"could not complete"): module.verify_shot_executions(state,jobs,ledger,reviews)

    def test_checkpoint_manifest_is_required_and_full_record_validator_receives_actual_roles_and_clock(self):
        body=b"actual-fixture-bytes"; record={"path":"project/film/clips/shot.mp4","sha256":hashlib.sha256(body).hexdigest(),"bytes":len(body)}
        job={"id":"film","projectId":"project","status":"failed","checkpointShots":1,"checkpointFrame":30,"executionCheckpoints":[{"capture":None}]}
        cost={"provider":"mock","model":"mock-deterministic-v1","prompt_tokens":4,"output_frames":30,"gpu_seconds":0.5,"total_cost_usd":0}
        clips=[{"path":"C:/prior-worker/project/film/clips/shot.mp4","provider":"mock","model":"mock-deterministic-v1","seed":7,"durationSec":1,"fingerprint":record["sha256"],"cost":cost,"renderRecord":{"files":{"video":record}}}]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); media=root/"artifacts"/record["path"]; media.parent.mkdir(parents=True); media.write_bytes(body); manifest=media.with_name("manifest.json")
            with self.assertRaisesRegex(ValueError,"manifest is missing"): module.verify_execution_media(root,"project",[job])
            manifest.write_text(json.dumps({"schema":"hv-clips/1","clips":clips}))
            with patch.object(module,"verify_assembly_metadata") as verify:
                module.verify_execution_media(root,"project",[job]); payload,code,schema,kind=verify.call_args.args
                self.assertEqual(payload,[{"job":job,"clips":clips}]); self.assertIn("validateShotExecutionClips",code); self.assertIn("validateJobExecutionCheckpoint(job,payload)",code); self.assertIn("checkpointFrame",code); self.assertEqual(schema,11); self.assertEqual(kind,"execution checkpoint")
            bad=copy.deepcopy(clips); bad[0]["path"]="project/film/clips/other.mp4"; manifest.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError,"sealed role"): module.verify_execution_media(root,"project",[job])
            bad=copy.deepcopy(clips); bad[0]["capture"]={"schema":"hv-shot-execution-capture/1"}; manifest.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError,"public clip manifests"): module.verify_execution_media(root,"project",[job])
            manifest.write_text(json.dumps(clips)); media.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.verify_execution_media(root,"project",[job])
            # Expired originals nested in independent retained receipts need no old own-directory
            # checkpoint: their complete output is verified by the snapshot and carrier validators.
            module.verify_execution_media(root,"project",[])

class CurrentFilmScopeTests(unittest.TestCase):
    write_scope=AssemblyScopeTests.write_scope

    def test_schema_twelve_detects_checkpoint_only_and_nested_runtime_markers(self):
        for project,jobs in (({"id":"project"},[{"id":"film","projectId":"project","status":"failed","currentFilmCheckpoint":{}}]),({"id":"project","hidden":{"currentFilmReview":None}},[]),({"id":"project","retained":{"job":{"currentFilm":{}}}},[])):
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)
                for version in (1,10,11):
                    self.write_scope(root,project,jobs,"hv-state/"+str(version))
                    with self.assertRaisesRegex(ValueError,"schema 12"): module.project_scope(root,"project")
        self.assertFalse(module.current_screenplay_contexts({"projects":[{"id":"project"}]},[]))

    def test_current_film_manifest_delegates_exact_roles_and_actual_frame_probes_to_trusted_runtime(self):
        # Isolated Python-boundary fixture only. The Bun suite renders actual V2 films and
        # runs the real validator; these bytes do not stand in for a playable movie.
        body=b"current-film-role"; record={"path":"project/film/clips/shot.mp4","sha256":hashlib.sha256(body).hexdigest(),"bytes":len(body)}
        job={"id":"film","projectId":"project","status":"failed","checkpointShots":1,"checkpointFrame":30,"currentFilm":{},"currentFilmCheckpoint":{}}
        clips=[{"path":"C:/old/project/film/clips/shot.mp4","durationSec":1,"renderRecord":{"files":{"video":record}}}]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); path=root/"artifacts"/record["path"]; path.parent.mkdir(parents=True); path.write_bytes(body); manifest=path.with_name("manifest.json"); manifest.write_text(json.dumps(clips))
            with patch.object(module,"verify_assembly_metadata") as verify:
                module.verify_execution_media(root,"project",[job]); payload,code,schema,kind=verify.call_args.args
                self.assertEqual(payload,{"artifactRoot":str((root/"artifacts").resolve()),"items":[{"job":job,"clips":clips}]})
                self.assertIn("validateCurrentFilmClips(job,clips)",code); self.assertIn("await verifyCurrentFilmMedia(job,artifactRoot)",code); self.assertIn("queue/src/current-film-media.ts",code); self.assertEqual(schema,12); self.assertEqual(kind,"current-film media")
            with patch.dict(os.environ,{},clear=True),patch.object(module.shutil,"which",return_value=None):
                with self.assertRaisesRegex(ValueError,"schema 12.*requires Bun"): module.verify_execution_media(root,"project",[job])
            bad=copy.deepcopy(clips); bad[0]["unowned"]={"currentFilmCheckpoint":{}}; manifest.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError,"public clip manifests"): module.verify_execution_media(root,"project",[job])
            manifest.write_text(json.dumps(clips)); path.write_bytes(b"bad")
            with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.verify_execution_media(root,"project",[job])

    def test_schema_twelve_full_snapshot_bridge_rejects_failure_timeout_or_unverified_response(self):
        state={"projects":[{"id":"project"}]}; jobs=[{"currentFilm":{}}]; ledger={"events":[],"reservations":[]}
        for result in (subprocess.CompletedProcess([],1,b"",b"invalid clock"),subprocess.CompletedProcess([],0,b"unchecked",b"")):
            with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=result):
                with self.assertRaisesRegex(ValueError,"invalid sealed current screenplay"): module.verify_current_screenplay(state,jobs,ledger,[])
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",side_effect=subprocess.TimeoutExpired("bun",60)):
            with self.assertRaisesRegex(ValueError,"could not complete"): module.verify_current_screenplay(state,jobs,ledger,[])

class CurrentFilmSourceScopeTests(unittest.TestCase):
    write_scope=AssemblyScopeTests.write_scope

    def complete_editorial_fixture(self,root,status="done"):
        bodies={"project/carrier/sources/current/original/project/current/export.mp4":b"retained-current-picture",
            "project/carrier/sources/current/audio/dialogue.wav":b"converted-48000-dialogue",
            "project/carrier/sources/sources.json":b"sealed-source-manifest",
            "project/carrier/conform/export.mp4":b"conformed-picture"}
        records=[{"path":path,"bytes":len(body),"sha256":hashlib.sha256(body).hexdigest()} for path,body in bodies.items()]
        original={**records[0],"path":"project/current/export.mp4"}
        source={"schema":"hv-edit-source/3","revision":"a"*64,"job":{"id":"current","projectId":"project","status":"done","currentFilm":{},"output":{"mp4Path":original["path"]}},"files":[original]}
        result={"prepared":{"sources":[{"receipt":source,"copies":[{"original":original,"copy":records[0]}]}]},"files":records}
        job={"id":"carrier","projectId":"project","stage":"picture-edit","status":status,"editCheckpoint":{"editorial":result}}
        if status=="done": job["output"]={"editorial":result}
        self.write_scope(root,{"id":"project"},[job],"hv-state/13")
        for path,body in bodies.items():
            target=root/"artifacts"/path; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(body)
        return job,bodies

    def test_editorial_archive_checks_all_derived_files_with_originals_still_intact(self):
        # Isolate Python custody, not the separate Bun seals or decoder. Each corrupted
        # role is outside the retained-original list and remains named by the sealed output.
        for status in ("done","failed","cancelled"):
            with self.subTest(status=status),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)/"source"; job,bodies=self.complete_editorial_fixture(root,status)
                with patch.object(module,"verify_current_screenplay"),patch.object(module,"verify_current_source_media"):
                    self.assertEqual(module.project_scope(root,"project"),[job])
                    for index,(key,body) in enumerate(list(bodies.items())[1:]):
                        path=root/"artifacts"/key
                        for missing in (True,False):
                            with self.subTest(role=key,missing=missing):
                                if missing: path.unlink()
                                else: path.write_bytes(b"x"*len(body))
                                archive=Path(temporary)/f"bad-{index}-{missing}.zip"
                                with self.assertRaisesRegex(ValueError,"editorial is missing or corrupt"): module.pack(root,archive,"project")
                                self.assertFalse(archive.exists()); self.assertEqual(list(Path(temporary).glob("*.pending")),[])
                                path.write_bytes(body)
                    self.assertFalse((root/"artifacts/project/current").exists())

    def test_editorial_unpack_rejects_reindexed_archive_missing_a_sealed_conversion(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary); root=base/"source"; _,bodies=self.complete_editorial_fixture(root)
            archive=base/"complete.zip"; omitted="artifacts/"+list(bodies)[1]
            with patch.object(module,"verify_current_screenplay"),patch.object(module,"verify_current_source_media"):
                module.pack(root,archive,"project")
                with zipfile.ZipFile(archive) as saved: entries=[(info,saved.read(info)) for info in saved.infolist() if info.filename!=omitted]
                manifest=json.loads(entries[0][1]); manifest["files"]=[entry for entry in manifest["files"] if entry["path"]!=omitted]
                manifest["totalBytes"]=sum(entry["bytes"] for entry in manifest["files"])
                entries[0]=(entries[0][0],json.dumps(manifest).encode())
                with zipfile.ZipFile(archive,"w") as changed:
                    for info,body in entries: changed.writestr(info,body)
                with zipfile.ZipFile(archive) as changed: module.inspect(changed)
                with self.assertRaisesRegex(ValueError,"editorial is missing or corrupt"): module.unpack(archive,base/"restored")
                self.assertFalse((base/"restored").exists()); self.assertEqual(list(base.glob("restored.*.pending")),[])

    def test_schema_thirteen_detects_orphan_and_abandoned_receipts_before_any_runtime_allowance(self):
        for project,jobs in (({"id":"project","hidden":{"schema":"hv-edit-source/3"}},[]),({"id":"project"},[{"id":"carrier","projectId":"project","status":"failed","abandoned":[{"schema":"hv-edit-source/3"}]}])):
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)
                for version in (1,4,11,12):
                    self.write_scope(root,project,jobs,"hv-state/"+str(version))
                    with self.assertRaisesRegex(ValueError,"schema 13"): module.project_scope(root,"project")
        self.assertEqual(module.current_film_sources({"id":"project"},[]),[])

    def test_schema_thirteen_bridge_binds_whole_snapshot_and_fails_closed(self):
        state={"projects":[{"id":"project","hidden":{"schema":"hv-edit-source/3"}}]}; jobs=[]; ledger={"events":[],"reservations":[]}
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],0,b"verified",b"")) as run:
            module.verify_current_screenplay(state,jobs,ledger,[],13); args,kwargs=run.call_args
            self.assertIn("validateSnapshot",args[0][2]); self.assertIn("storage/src/snapshots.ts",args[0][2]); self.assertNotIn("shell",kwargs)
            self.assertEqual(json.loads(kwargs["input"]),{"schema":"hv-state/13","projects":state,"jobs":jobs,"ledger":ledger,"reviews":[]})
        with patch.dict(os.environ,{},clear=True),patch.object(module.shutil,"which",return_value=None):
            with self.assertRaisesRegex(ValueError,"schema 13.*requires Bun"): module.verify_current_screenplay(state,jobs,ledger,[],13)
        for result in (subprocess.CompletedProcess([],1,b"",b"invalid receipt"),subprocess.CompletedProcess([],0,b"unchecked",b"")):
            with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=result):
                with self.assertRaisesRegex(ValueError,"invalid sealed current screenplay"): module.verify_current_screenplay(state,jobs,ledger,[],13)

    def test_retained_current_media_uses_exact_original_namespace_without_original_job_or_hls(self):
        # Isolate Python custody here. The Bun suite separately generates a real source
        # and editorial carrier, then pack/unpacks with the actual media verifier.
        body=b"retained-current-media"; record={"path":"project/current/export.mp4","bytes":len(body),"sha256":hashlib.sha256(body).hexdigest()}
        source={"schema":"hv-edit-source/3","revision":"a"*64,"job":{"id":"current","projectId":"project","status":"done","currentFilm":{},"output":{"mp4Path":record["path"],"hlsPlaylistPath":"project/current/unused.m3u8"}},"files":[record]}
        namespace="project/carrier/sources/current/original/"; copied={**record,"path":namespace+record["path"]}
        retained={"receipt":source,"copies":[{"original":record,"copy":copied}]}; carrier={"id":"carrier","projectId":"project","status":"done","stage":"picture-edit","output":{"editorial":{"prepared":{"sources":[retained]},"files":[copied]}}}
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); path=root/"artifacts"/copied["path"]; path.parent.mkdir(parents=True); path.write_bytes(body); self.write_scope(root,{"id":"project"},[carrier],"hv-state/13"); before=(root/"queue/jobs.json").read_bytes()
            with patch.object(module,"verify_current_screenplay") as metadata,patch.object(module,"verify_current_source_media") as media:
                self.assertEqual(module.project_scope(root,"project"),[carrier]); metadata.assert_called_once()
                media.assert_called_once_with([{"job":source["job"],"artifactRoot":str((root/"artifacts"/namespace).resolve())}])
                self.assertFalse((root/"artifacts/project/current").exists()); self.assertEqual((root/"queue/jobs.json").read_bytes(),before)
                path.write_bytes(b"corrupt")
                with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.project_scope(root,"project")
            with patch.object(module,"verify_assembly_metadata") as verify:
                items=[{"job":source["job"],"artifactRoot":str(root/"artifacts"/namespace)}]; module.verify_current_source_media(items)
                payload,code,schema,kind=verify.call_args.args; self.assertEqual(payload,items); self.assertIn("verifyCurrentFilmMedia(job,artifactRoot)",code); self.assertIn("queue/src/current-film-media.ts",code); self.assertEqual(schema,13); self.assertEqual(kind,"retained current-film media")

class SchemaConformanceTests(unittest.TestCase):
    """HV-040-04: the Python validator, its wiring into pack/inspect/project_scope/verify_execution_media,
    and the committed golden archive (packages/storage/test/fixtures/archive-golden). The rejection matrix
    is the same rejections.json table the TypeScript suites apply, so both validators face one list."""
    GOLDEN=Path(__file__).resolve().parent.parent/"packages/storage/test/fixtures/archive-golden"
    SOURCE=GOLDEN/"source"

    @classmethod
    def receipt(cls): return json.loads((cls.GOLDEN/"receipt.json").read_text(encoding="utf-8"))
    @classmethod
    def job_id(cls):
        jobs=[child.name for child in (cls.SOURCE/"artifacts"/cls.receipt()["projectId"]).iterdir()]; assert len(jobs)==1; return jobs[0]
    @classmethod
    def document(cls,name):
        path=cls.GOLDEN/"archive.json" if name=="hv-project-archive/1" else cls.SOURCE/"snapshot.json" if name=="hv-state/1" else cls.SOURCE/"artifacts"/cls.receipt()["projectId"]/cls.job_id()/"clips/manifest.json"
        return json.loads(path.read_text(encoding="utf-8"))
    @classmethod
    def rows(cls): return json.loads((cls.GOLDEN/"rejections.json").read_text(encoding="utf-8"))["rows"]
    @staticmethod
    def mutate(base,row):
        expand=lambda value:value["$repeat"][0]*value["$repeat"][1] if isinstance(value,dict) and isinstance(value.get("$repeat"),list) else value
        document=copy.deepcopy(base); tokens=[token.replace("~1","/").replace("~0","~") for token in row["pointer"].split("/")[1:]]; last=tokens.pop()
        parent=document
        for token in tokens: parent=parent[int(token)] if isinstance(parent,list) else parent[token]
        key=int(last) if isinstance(parent,list) else last
        if row["op"]=="set": parent[key]=expand(row["value"])
        elif row["op"]=="delete": del parent[key]
        elif row["op"]=="replicate": template=parent[key][0]; parent[key]=[{**copy.deepcopy(template),"path":template["path"]+"-"+str(index)} for index in range(row["count"])]
        else: raise AssertionError("unknown matrix operation "+str(row["op"]))
        return document
    def violation(self,name,value):
        failure=module.validate_document(module.load_schema(name),value); self.assertIsNotNone(failure); return failure

    def test_schema_files_declare_dialect_urn_identity_and_only_the_dialect_url(self):
        for name,file in module.SCHEMA_FILES.items():
            text=(module.SCHEMA_DIR/file).read_text(encoding="utf-8"); schema=module.load_schema(name)
            self.assertEqual(schema["$schema"],"https://json-schema.org/draft/2020-12/schema"); self.assertEqual(schema["$id"],"urn:hollywood-video:schema:"+name.replace("/",":"))
            self.assertIsInstance(schema["title"],str); self.assertIsInstance(schema["description"],str)
            self.assertEqual(re.findall(r"https?://[^\"\s]*",text),["https://json-schema.org/draft/2020-12/schema"])
            self.assertIs(module.load_schema(name),schema)
        with self.assertRaisesRegex(ValueError,"unknown archive schema"): module.load_schema("hv-project-archive/2")

    def test_unsupported_keywords_raise_instead_of_passing(self):
        for schema in ({"oneOf":[{"type":"string"}]},{"anyOf":[]},{"type":"string","format":"uri"},{"type":"integer","exclusiveMinimum":0},{"type":"object","patternProperties":{"^x":{}}},
                       {"$ref":"https://example.invalid/schema.json"},{"$ref":"other.json#/$defs/x"},{"$ref":"#/$defs/missing","$defs":{}},{"type":"object","properties":{"a":{"type":"array","items":{"type":"string","minContains":1}}}},
                       {"$defs":{"x":{"allOf":[]}}},{"type":"object","additionalProperties":{"type":"string"}},{"type":["string","null"]},{"type":"date"},{"type":"string","pattern":"[a-z]+"},{"type":"object","properties":{"a":True}},
                       {"type":"object","properties":{"never":{"format":"email"}}}):
            with self.subTest(schema=schema),self.assertRaisesRegex(ValueError,"unsupported schema keyword"): module.validate_document(schema,{})

    def test_each_supported_keyword_reports_the_first_violation_with_its_pointer(self):
        v=module.validate_document; string={"type":"string"}; integer={"type":"integer"}; number={"type":"number"}
        self.assertIsNone(v(string,"x")); self.assertEqual(v(string,1),("","expected string, found integer")); self.assertIsNone(v(integer,1)); self.assertEqual(v(integer,1.5),("","expected integer, found number"))
        self.assertEqual(v(integer,True),("","expected integer, found boolean")); self.assertEqual(v(integer,1.0),("","expected integer, found number")); self.assertIsNone(v(number,1)); self.assertIsNone(v(number,1.5)); self.assertEqual(v(number,"1"),("","expected number, found string"))
        self.assertEqual(v(number,float("inf")),("","expected number, found non-finite number")); self.assertEqual(v({"type":"boolean"},0),("","expected boolean, found integer")); self.assertIsNone(v({"type":"boolean"},False)); self.assertIsNone(v({"type":"null"},None))
        self.assertIsNone(v({"type":"object"},{})); self.assertEqual(v({"type":"object"},[]),("","expected object, found array")); self.assertEqual(v({"type":"object"},None),("","expected object, found null")); self.assertEqual(v({"type":"array"},{}),("","expected array, found object"))
        obj={"type":"object","required":["a","b/c"],"properties":{"a":integer,"b/c":string,"d~e":string},"additionalProperties":False}
        self.assertIsNone(v(obj,{"a":1,"b/c":"x"})); self.assertEqual(v(obj,{"a":1}),("/b~1c","required property is missing")); self.assertEqual(v(obj,{"a":"1","b/c":"x"}),("/a","expected integer, found string"))
        self.assertEqual(v(obj,{"a":1,"b/c":"x","d~e":1}),("/d~0e","expected string, found integer")); self.assertEqual(v(obj,{"a":1,"b/c":"x","extra":1}),("/extra","unexpected property")); self.assertIsNone(v({"type":"object","properties":{"a":integer}},{"a":1,"anything":"open"}))
        self.assertEqual(v({"enum":["a","b"]},"c"),("","value is not one of the enumerated values")); self.assertIsNone(v({"enum":["a",1]},1)); self.assertIsNotNone(v({"enum":[1]},True)); self.assertIsNotNone(v({"enum":[True]},1))
        self.assertIsNone(v({"const":"hv-clips/1"},"hv-clips/1")); self.assertEqual(v({"const":"hv-clips/1"},"hv-clips/2"),("",'value must equal "hv-clips/1"')); self.assertIsNotNone(v({"const":1},True))
        pattern={"type":"string","pattern":"^[a-f0-9]{4}$"}; self.assertIsNone(v(pattern,"beef")); self.assertEqual(v(pattern,"BEEF"),("","string does not match ^[a-f0-9]{4}$")); self.assertIsNotNone(v(pattern,"beef\n")); self.assertIsNotNone(v(pattern,"xbeef"))
        bounded={"type":"integer","minimum":0,"maximum":10}; self.assertIsNone(v(bounded,0)); self.assertIsNone(v(bounded,10)); self.assertEqual(v(bounded,-1),("","number is less than 0")); self.assertEqual(v(bounded,11),("","number is greater than 10"))
        length={"type":"string","minLength":1,"maxLength":3}; self.assertIsNone(v(length,"abc")); self.assertEqual(v(length,""),("","string is shorter than 1")); self.assertEqual(v(length,"abcd"),("","string is longer than 3")); self.assertIsNone(v(length,"\U0001F3AC"*3))
        array={"type":"array","minItems":1,"maxItems":2,"uniqueItems":True,"items":integer}; self.assertIsNone(v(array,[1,2])); self.assertEqual(v(array,[]),("","array has fewer than 1 items")); self.assertEqual(v(array,[1,2,3]),("","array has more than 2 items"))
        self.assertEqual(v(array,[1,1]),("/1","array item is a duplicate")); self.assertEqual(v(array,[1,"2"]),("/1","expected integer, found string")); self.assertEqual(v({"type":"array","uniqueItems":True},[{"a":1,"b":2},{"b":2,"a":1}]),("/1","array item is a duplicate")); self.assertIsNone(v({"type":"array","uniqueItems":True},[1,True,"1",1.5]))
        ref={"type":"object","properties":{"digest":{"$ref":"#/$defs/sha256"},"list":{"type":"array","items":{"$ref":"#/$defs/sha256","maxLength":64}}},"$defs":{"sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"}}}
        self.assertIsNone(v(ref,{"digest":"a"*64,"list":["b"*64]})); self.assertEqual(v(ref,{"digest":"A"*64}),("/digest","string does not match ^[a-f0-9]{64}$")); self.assertEqual(v(ref,{"list":[1]}),("/list/0","expected string, found integer")); self.assertIsNotNone(v(ref,{"list":["a"*63]}))
        self.assertEqual(v(integer,"x","/nested/2"),("/nested/2","expected integer, found string"))
        with self.assertRaisesRegex(ValueError,r"^archive schema violation: /clips/0/path: required property is missing$"): module.assert_document("hv-clips/1",{"schema":"hv-clips/1","clips":[{}]})
        self.assertEqual(module.assert_document("hv-clips/1",{"schema":"hv-clips/1","clips":[]}),{"schema":"hv-clips/1","clips":[]})
        self.assertEqual(module.canonical_json({"b":1,"a":"\u00e9\n"}),'{"a":"\\u00e9\\n","b":1}')

    def test_module_constants_equal_the_schema_numbers_and_the_state_enum(self):
        archive=module.load_schema("hv-project-archive/1"); state=module.load_schema("hv-state/1"); clips=module.load_schema("hv-clips/1")
        self.assertEqual(archive["properties"]["files"]["maxItems"],module.MAX_FILES); self.assertEqual(archive["$defs"]["file"]["properties"]["bytes"]["maximum"],module.MAX_FILE_BYTES); self.assertEqual(archive["properties"]["totalBytes"]["maximum"],module.MAX_TOTAL_BYTES)
        self.assertEqual((module.MAX_FILES,module.MAX_FILE_BYTES,module.MAX_TOTAL_BYTES,module.MAX_MANIFEST_BYTES,module.MAX_STATE_FILE_BYTES),(100000,8589934592,68719476736,8388608,268435456))
        self.assertEqual(archive["properties"]["schema"]["const"],module.SCHEMA); self.assertEqual(archive["properties"]["projectId"]["pattern"],"^"+module.ID.pattern.strip("^$")+"$")
        self.assertEqual(list(state["properties"]["schema"]["enum"]),list(module.STATE_SCHEMAS)); self.assertEqual(list(module.STATE_SCHEMAS),["hv-state/%d"%n for n in range(1,14)])
        self.assertEqual(state["properties"]["files"]["required"],sorted(module.STATE_FILES-{"snapshot.json"},key=state["properties"]["files"]["required"].index)); self.assertEqual(clips["properties"]["schema"]["const"],"hv-clips/1"); self.assertNotIn("additionalProperties",clips["$defs"]["clip"])
        self.assertEqual(self.violation("hv-state/1",{"schema":"hv-state/14","files":{}}),("/schema","value is not one of the enumerated values"))
        for name in module.SCHEMA_FILES: self.assertIsNone(module.validate_document(module.load_schema(name),self.document(name)),name)

    def test_golden_pack_reproduces_the_committed_manifest_and_is_deterministic_in_one_interpreter(self):
        receipt=self.receipt(); expected=(self.GOLDEN/"archive.json").read_bytes()
        self.assertEqual(json.loads(expected),self.document("hv-project-archive/1")); self.assertEqual(hashlib.sha256(expected).hexdigest(),receipt["manifestSha256"]); self.assertEqual(module.canonical_json(json.loads(expected)).encode(),expected)
        self.assertEqual(sorted(json.loads(expected)),["files","projectId","schema","totalBytes"]); self.assertNotRegex(expected.decode(),r"\d{4}-\d{2}-\d{2}T|\\\\|\"path\":\"/")
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary); first=base/"first.zip"; second=base/"second.zip"
            packed=module.pack(self.SOURCE,first,receipt["projectId"]); self.assertEqual({key:packed[key] for key in receipt},receipt)
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(archive.read("archive.json"),expected); info=archive.getinfo("archive.json"); self.assertEqual(info.date_time,(1980,1,1,0,0,0)); self.assertEqual(stat.S_IFMT(info.external_attr>>16),stat.S_IFREG)
                self.assertEqual({entry.date_time for entry in archive.infolist()},{(1980,1,1,0,0,0)}); manifest,files=module.inspect(archive); self.assertEqual(manifest,json.loads(expected)); self.assertEqual(len(files),receipt["files"])
            module.pack(self.SOURCE,second,receipt["projectId"]); self.assertEqual(first.read_bytes(),second.read_bytes()); self.assertEqual(hashlib.sha256(first.read_bytes()).hexdigest(),packed["archiveSha256"])
            restored=base/"restored"; unpacked=module.unpack(first,restored); self.assertEqual(unpacked,{"projectId":receipt["projectId"],"files":receipt["files"],"bytes":receipt["bytes"],"archiveSha256":packed["archiveSha256"]})
            for path in self.SOURCE.rglob("*"):
                if path.is_file(): self.assertEqual(path.read_bytes(),(restored/path.relative_to(self.SOURCE)).read_bytes())
            repacked=module.pack(restored,base/"third.zip",receipt["projectId"]); self.assertEqual(repacked["manifestSha256"],receipt["manifestSha256"]); self.assertEqual((base/"third.zip").read_bytes(),first.read_bytes())
            self.assertEqual(module.project_scope(self.SOURCE,receipt["projectId"]),json.loads((self.SOURCE/"queue/jobs.json").read_text(encoding="utf-8")))

    def test_rejection_matrix_through_the_validator_and_every_real_entry_point(self):
        rows=self.rows(); receipt=self.receipt(); project=receipt["projectId"]; job_id=self.job_id(); self.assertGreaterEqual(len(rows),33); self.assertEqual({row["document"] for row in rows},set(module.SCHEMA_FILES))
        for row in rows:
            with self.subTest(row=row["name"]): self.assertEqual(self.violation(row["document"],self.mutate(self.document(row["document"]),row))[0],row["expect"])
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary); pristine=base/"golden.zip"; module.pack(self.SOURCE,pristine,project)
            with zipfile.ZipFile(pristine) as archive: entries=[(info,archive.read(info)) for info in archive.infolist()]
            for row in [row for row in rows if row["document"]=="hv-project-archive/1"]:
                with self.subTest(entry="inspect",row=row["name"]):
                    target=base/("archive-%d.zip"%rows.index(row)); mutated=json.dumps(self.mutate(self.document("hv-project-archive/1"),row)).encode()
                    with warnings.catch_warnings(),zipfile.ZipFile(target,"w") as rewritten:
                        warnings.simplefilter("ignore",UserWarning)
                        for info,body in entries: rewritten.writestr(info,mutated if info.filename=="archive.json" else body)
                    with self.assertRaisesRegex(ValueError,re.escape(row.get("entry","archive schema violation: "+row["expect"]+":"))): module.unpack(target,base/"restored")
                    self.assertFalse((base/"restored").exists()); self.assertEqual(list(base.glob("restored.*.pending")),[])
            for row in [row for row in rows if row["document"]=="hv-state/1"]:
                with self.subTest(entry="project_scope",row=row["name"]):
                    root=base/("state-%d"%rows.index(row)); shutil.copytree(self.SOURCE,root); (root/"snapshot.json").write_text(json.dumps(self.mutate(self.document("hv-state/1"),row)),encoding="utf-8")
                    with self.assertRaisesRegex(ValueError,re.escape("archive schema violation: "+row["expect"]+":")): module.project_scope(root,project)
                    with self.assertRaisesRegex(ValueError,re.escape("archive schema violation: "+row["expect"]+":")): module.pack(root,base/("state-%d.zip"%rows.index(row)),project)
                    self.assertEqual(list(base.glob("*.pending")),[])
            job={"id":job_id,"projectId":project,"status":"failed","checkpointShots":1,"checkpointFrame":30,"executionCheckpoints":[]}
            root=base/"clips"; shutil.copytree(self.SOURCE,root); manifest=root/"artifacts"/project/job_id/"clips/manifest.json"
            for row in [row for row in rows if row["document"]=="hv-clips/1"]:
                with self.subTest(entry="verify_execution_media",row=row["name"]):
                    manifest.write_text(json.dumps(self.mutate(self.document("hv-clips/1"),row)),encoding="utf-8")
                    with self.assertRaisesRegex(ValueError,re.escape("archive schema violation: "+row["expect"]+":")): module.verify_execution_media(root,project,[job])
            # The unmodified golden manifest passes the contract and reaches the later sealed-record check.
            manifest.write_text(json.dumps(self.document("hv-clips/1")),encoding="utf-8")
            with self.assertRaisesRegex(ValueError,"sealed shot record"): module.verify_execution_media(root,project,[job])

if __name__=="__main__": unittest.main()
