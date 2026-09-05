import importlib.util
from pathlib import Path
import tempfile
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

if __name__ == "__main__": unittest.main()
