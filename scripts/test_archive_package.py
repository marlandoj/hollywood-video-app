import hashlib, importlib.util, json, os, stat, tempfile, unittest, warnings, zipfile
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

if __name__=="__main__": unittest.main()
