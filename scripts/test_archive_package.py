import hashlib, importlib.util, json, stat, tempfile, unittest, warnings, zipfile
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
            "state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[],"snapshot.json":{}}
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
        self.assertEqual(stat.S_IMODE(self.archive.stat().st_mode),0o600)
        with self.assertRaises(ValueError): module.pack(self.source,self.archive,"project-one")
        with self.assertRaises(ValueError): module.unpack(self.archive,self.root/"restored")
    def test_duplicate_entry(self):
        self.rewrite(lambda entries:entries+[entries[-1]]); self.rejected()
    def test_unlisted_traversal(self):
        self.rewrite(lambda entries:entries+[("../escaped",b"bad")]); self.rejected()
        self.assertFalse((self.root/"escaped").exists())
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
        (self.media.parent/"link").symlink_to(self.media)
        with self.assertRaisesRegex(ValueError,"links|regular"): module.pack(self.source,self.root/"bad.zip","project-one")
    def test_invalid_manifest_type(self):
        self.rewrite(lambda entries:[(entries[0][0],b"[]")]+entries[1:]); self.rejected()

if __name__=="__main__": unittest.main()
