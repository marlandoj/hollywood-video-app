import importlib.util
import os
import re
from pathlib import Path
import tempfile
import subprocess
import time
from unittest.mock import MagicMock, patch
import unittest

spec = importlib.util.spec_from_file_location("bootstrap_storage", Path(__file__).with_name("bootstrap-storage-platform.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)

class BootstrapConfigurationTests(unittest.TestCase):
    def test_preserves_unrelated_configuration_and_is_idempotent(self):
        current = "[supervisord]\nlogfile=/tmp/supervisor.log\n[program:unrelated]\ncommand=/bin/service --value=100%%\n"
        root = Path("/workspace/storage")
        result, added = bootstrap.merged_config(current, root)
        self.assertTrue(result.startswith(current))
        self.assertEqual(set(added), set(bootstrap.SERVICES))
        self.assertEqual(bootstrap.merged_config(result, root), (result, []))

    def test_refuses_to_replace_another_program(self):
        current = "[program:rough-cut-storage-postgres]\ncommand=/another/database\n"
        with self.assertRaisesRegex(RuntimeError, "already assigned"):
            bootstrap.merged_config(current, Path("/workspace/storage"))

    def test_cannot_initialize_missing_data_or_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                bootstrap.require_existing(root)
            self.assertEqual(list(root.iterdir()), [])

class BootstrapReadinessTests(unittest.TestCase):
    def test_probe_timeout_retries_within_the_outer_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "postgres-secrets.json").write_text('{"hv_admin":"fixture-only"}')
            response = MagicMock()
            response.__enter__.return_value.status = 200
            results = [subprocess.TimeoutExpired("psql", 5), subprocess.CompletedProcess("psql", 0, "1\n", "")]
            with patch.object(bootstrap.subprocess, "run", side_effect=results) as probe, \
                 patch.object(bootstrap.ssl, "create_default_context"), \
                 patch.object(bootstrap.urllib.request, "urlopen", return_value=response), \
                 patch.object(bootstrap.time, "sleep"):
                bootstrap.ready(root, time.monotonic() + 5)
                self.assertEqual(probe.call_count, 2)
                with self.assertRaisesRegex(RuntimeError, "deadline"):
                    bootstrap.ready(root, time.monotonic() - 1)
                self.assertEqual(probe.call_count, 2)

if __name__ == "__main__": unittest.main()


def _load(name, filename, environ):
    with patch.dict(os.environ, environ):
        for key in ("HV_SUPERVISOR_CONFIG", "HV_SUPERVISOR_RPC_URL"):
            if key not in environ: os.environ.pop(key, None)
        module_spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        return module


class HostConfigTests(unittest.TestCase):
    """Release 1 step 1 (HV-032-03): the supervisor is a setting, not Zo's path in seven files."""

    def setUp(self):
        self.host = _load("host_config_under_test", "host_config.py", {})

    def test_unset_keeps_zo_so_the_current_host_is_unchanged(self):
        self.assertEqual(self.host.supervisor_config({}), Path("/etc/zo/supervisord-user.conf"))
        self.assertEqual(self.host.supervisor_rpc_url({}), "http://127.0.0.1:29011/RPC2")

    def test_a_host_names_its_own_supervisor(self):
        self.assertEqual(self.host.supervisor_config({"HV_SUPERVISOR_CONFIG": "/etc/rough-cut/supervisord.conf"}),
                         Path("/etc/rough-cut/supervisord.conf"))
        self.assertEqual(self.host.supervisor_rpc_url({"HV_SUPERVISOR_RPC_URL": "http://127.0.0.1:9001/RPC2"}),
                         "http://127.0.0.1:9001/RPC2")

    def test_refuses_a_path_that_depends_on_the_working_directory(self):
        for value in ("", "supervisord.conf", "./supervisord.conf", " /etc/x.conf", "/etc/x.conf\n"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "absolute path"):
                self.host.supervisor_config({"HV_SUPERVISOR_CONFIG": value})

    def test_refuses_to_drive_a_supervisor_on_another_machine(self):
        for value in ("", "http://10.0.0.5:29011/RPC2", "https://127.0.0.1:29011/RPC2", "http://127.0.0.1/RPC2",
                      "unix:///run/supervisor.sock", "http://127.0.0.1.evil.example:29011/RPC2"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "loopback"):
                self.host.supervisor_rpc_url({"HV_SUPERVISOR_RPC_URL": value})

    def test_every_script_that_registers_programs_reads_the_setting(self):
        target = "/tmp/hv-host-config-test/supervisord.conf"
        for name, filename in (("bootstrap_under_test", "bootstrap-storage-platform.py"),
                               ("launch_under_test", "storage-runtime-launch.py"),
                               ("observability_under_test", "observability-runtime.py")):
            with self.subTest(script=filename):
                self.assertEqual(_load(name, filename, {"HV_SUPERVISOR_CONFIG": target}).CONFIG, Path(target))
                self.assertEqual(_load(name, filename, {}).CONFIG, Path("/etc/zo/supervisord-user.conf"))

    def test_no_script_names_the_zo_supervisor_itself(self):
        scripts = Path(__file__).parent
        allowed = {"host_config.py", "host-config.ts"}
        offenders = [path.name for path in sorted(scripts.glob("*")) if path.suffix in (".py", ".ts") and path.is_file()
                     and path.name not in allowed and not path.name.startswith("test_")
                     and ("/etc/zo" in path.read_text() or "29011" in path.read_text())]
        self.assertEqual(offenders, [])

    def test_every_script_that_drives_supervisor_asks_the_setting_for_its_file(self):
        scripts = Path(__file__).parent
        drivers = [path for path in sorted(scripts.glob("*.py"))
                   if not path.name.startswith("test_") and path.name != "host_config.py" and "supervisorctl" in path.read_text()]
        self.assertGreaterEqual(len(drivers), 6)
        for path in drivers:
            text = path.read_text()
            with self.subTest(script=path.name):
                # Either asks the setting itself, or uses the launcher's CONFIG, which does.
                self.assertTrue("host_config.supervisor_config()" in text or "runtime.CONFIG" in text)
                self.assertIsNone(re.search(r"(?i)\bconfig\s*=\s*Path\(", text))
