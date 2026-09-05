import importlib.util
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
