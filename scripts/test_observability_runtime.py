import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec=importlib.util.spec_from_file_location("observability_install",Path(__file__).with_name("install-observability-runtime.py"))
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)

class RuntimeInstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix="hv-telemetry-install-")
        self.root=Path(self.temporary.name)
        for name in ("bin","downloads"):installer.directory(self.root/name)
    def tearDown(self):self.temporary.cleanup()
    def fixture(self,duplicate=False):
        payload=io.BytesIO()
        with tarfile.open(fileobj=payload,mode="w:gz") as archive:
            entries=[("package/tool",b"fixture-executable"),("../../outside",b"not-extracted")]
            if duplicate:entries.append(("package/tool",b"duplicate"))
            for name,data in entries:
                member=tarfile.TarInfo(name);member.size=len(data);archive.addfile(member,io.BytesIO(data))
        data=payload.getvalue();checksum=hashlib.sha256(data).hexdigest()
        path=self.root/"downloads"/(checksum+".tar.gz");path.write_bytes(data)
        return {"name":"fixture","version":"1.0","bytes":len(data),"url":"https://example.invalid/no-network","sha256":checksum,"members":{"tool":"package/tool"}},path
    def test_pinned_archive_extracts_only_named_regular_files_and_is_idempotent(self):
        release,_=self.fixture();first=installer.install(self.root,release);second=installer.install(self.root,release)
        self.assertEqual(first,second);self.assertEqual((self.root/"bin/tool-1.0").read_bytes(),b"fixture-executable")
        self.assertEqual(sorted(path.name for path in (self.root/"bin").iterdir()),["tool-1.0"])
        self.assertFalse((self.root/"outside").exists())
    def test_corrupt_cached_archive_is_rejected_before_extraction(self):
        release,path=self.fixture();data=path.read_bytes();path.write_bytes(b"x"+data[1:])
        with self.assertRaisesRegex(RuntimeError,"checksum"):installer.install(self.root,release)
        self.assertEqual(list((self.root/"bin").iterdir()),[])
    def test_duplicate_executables_are_rejected(self):
        release,_=self.fixture(duplicate=True)
        with self.assertRaisesRegex(RuntimeError,"expected regular executable"):installer.install(self.root,release)
    def test_changed_existing_executable_is_not_overwritten(self):
        release,_=self.fixture();target=self.root/"bin/tool-1.0";target.write_bytes(b"unrelated")
        with self.assertRaisesRegex(RuntimeError,"differs"):installer.install(self.root,release)
        self.assertEqual(target.read_bytes(),b"unrelated")

if __name__=="__main__":unittest.main()
