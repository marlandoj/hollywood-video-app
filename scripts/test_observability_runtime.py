import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

spec=importlib.util.spec_from_file_location("observability_install",Path(__file__).with_name("install-observability-runtime.py"))
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
runtime_spec=importlib.util.spec_from_file_location("observability_runtime",Path(__file__).with_name("observability-runtime.py"))
runtime=importlib.util.module_from_spec(runtime_spec);runtime_spec.loader.exec_module(runtime)

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

class RuntimeConfigurationTests(unittest.TestCase):
    def test_registration_preserves_unrelated_services_and_clears_inherited_credentials(self):
        root=Path('/home/workspace/.runtime/rough-cut-observability')
        unrelated='[program:unrelated]\ncommand=/keep/me\nenvironment=TOKEN="untouched"\n'
        result,changed=runtime.merged_configuration(unrelated,root)
        self.assertTrue(result.startswith(unrelated));self.assertEqual(len(changed),3)
        self.assertIn('command=/usr/bin/env -i PATH=',result);self.assertIn('user=hv-observability',result)
        self.assertEqual(runtime.merged_configuration(result,root),(result,[]))
        for service in runtime.SERVICES:
            self.assertEqual(set(runtime.service_environment(root,service)),{'PATH','HV_OBSERVABILITY_ROOT','GOMEMLIMIT'})
    def test_conflicting_service_names_are_not_overwritten(self):
        with self.assertRaisesRegex(RuntimeError,'another command'):
            runtime.merged_configuration('[program:rough-cut-observability-traces]\ncommand=/someone/else\n',Path('/runtime'))
    @unittest.skipUnless(os.name=='posix','POSIX permission boundary is verified on Linux')
    def test_config_integrity_detects_changed_runtime_files(self):
        with tempfile.TemporaryDirectory(prefix='hv-observation-config-') as folder:
            root=Path(folder);config=root/'config'/('a'*40);config.mkdir(parents=True)
            for name in runtime.SERVICES:(config/(name+'.yaml')).write_text('fixture');(config/(name+'.yaml')).chmod(0o644)
            launcher=root/'run-observability.py';launcher.write_text('fixture');launcher.chmod(0o644)
            value={'schema':'hv-observability-runtime/1','sourceSha':'a'*40,'configSha256':{name:runtime.sha(config/(name+'.yaml')) for name in runtime.SERVICES},'launcherSha256':runtime.sha(launcher)}
            manifest=root/'runtime.json';manifest.write_text(json.dumps(value));manifest.chmod(0o644)
            self.assertEqual(runtime.configuration(root),(value,config))
            (config/'jaeger.yaml').write_text('changed')
            with self.assertRaisesRegex(RuntimeError,'configuration integrity'):runtime.configuration(root)

if __name__=="__main__":unittest.main()
