import copy, hashlib, importlib.util, json, os, stat, subprocess, sys, tempfile, unittest, warnings, zipfile
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location("archive_package",Path(__file__).with_name("archive-package.py"))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name); self.source=self.root/"source"; self.source.mkdir()
        parts={"state/projects.json":{"version":1,"projects":[{"id":"project-one"}],"reviewLinks":[],"takenDown":[],"takedownLog":[]},
            "queue/jobs.json":[{"id":"job-one","projectId":"project-one","status":"done"}],
            "state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[],"snapshot.json":{"schema":"hv-state/1"}}
        for name,body in parts.items():
            path=self.source/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(body))
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
        (self.source/"snapshot.json").write_text(json.dumps({"schema":"hv-state/2"}))
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
            parts={"state/projects.json":state,"queue/jobs.json":[],"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[],"snapshot.json":{"schema":"hv-state/6"}}
            for name,body in parts.items():
                path=root/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(body))
            archive=Path(temporary)/"mattes.hv.zip"; target=Path(temporary)/"restored"
            module.pack(root,archive,"project"); module.unpack(archive,target)
            self.assertEqual(json.loads((target/"state/projects.json").read_text()),state)
            for schema in ("hv-state/4","hv-state/5"):
                (root/"snapshot.json").write_text(json.dumps({"schema":schema}))
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
            parts={"state/projects.json":state,"queue/jobs.json":[job],"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[],"snapshot.json":{"schema":"hv-state/4"}}
            for name,body in parts.items():
                path=root/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(body))
            media=root/"artifacts"/copy["path"]; media.parent.mkdir(parents=True); media.write_bytes(video)
            self.assertEqual(module.project_scope(root,"project"),[job])
            del state["projects"][0]["editLibrary"]
            (root/"state/projects.json").write_text(json.dumps(state))
            self.assertEqual(module.project_scope(root,"project"),[job])
            (root/"snapshot.json").write_text(json.dumps({"schema":"hv-state/3"}))
            with self.assertRaisesRegex(ValueError,"schema 4"): module.project_scope(root,"project")
            (root/"snapshot.json").write_text(json.dumps({"schema":"hv-state/4"}))
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
            parts={"state/projects.json":state,"queue/jobs.json":[source_job],"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[],"snapshot.json":{"schema":"hv-state/4"}}
            for name,body in parts.items():
                path=root/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(body))
            media=root/"artifacts"/record["path"]; media.parent.mkdir(parents=True); media.write_bytes(video)
            self.assertEqual(module.project_scope(root,"project"),[source_job])
            (root/"snapshot.json").write_text(json.dumps({"schema":"hv-state/3"}))
            with self.assertRaisesRegex(ValueError,"schema 4"): module.project_scope(root,"project")
            (root/"snapshot.json").write_text(json.dumps({"schema":"hv-state/4"}))
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
        parts={"state/projects.json":{"version":1,"projects":[project],"reviewLinks":[],"takenDown":[],"takedownLog":[]},"queue/jobs.json":jobs,"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[],"snapshot.json":{"schema":schema}}
        for name,value in parts.items():
            path=root/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(value))

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
        clips=[{"path":"C:/prior-worker/project/film/clips/shot.mp4","durationSec":1,"renderRecord":{"files":{"video":record}}}]
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

if __name__=="__main__": unittest.main()
