import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("deployment",Path(__file__).with_name("deploy-storage-staging.py"))
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)

class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="hv-deploy-");self.root=Path(self.temp.name)
        (self.root/"data/artifacts").mkdir(parents=True);(self.root/"data/state").mkdir()
        self.ledger=self.root/"data/state/cost-ledger.json";self.ledger.write_text('[{"total_cost_usd":123.45}]')
        self.marker=self.root/"storage-deployment.json";self.manifest={"database":"hollywood_video_staging","bucket":"rough-cut-staging"}
        deploy.runtime.private_json(self.marker,self.manifest)
    def tearDown(self):self.temp.cleanup()
    def test_evaluation_destinations_are_refused(self):
        deploy.identities("hollywood_video_staging_v2","rough-cut-staging-v2")
        for database,bucket in [("hollywood_video_migration_eval","rough-cut-staging"),("hollywood_video_staging","rough-cut-private"),("hollywood_video_staging';drop database x;--","rough-cut-staging")]:
            with self.assertRaises(RuntimeError):deploy.identities(database,bucket)
    def test_json_pointer_cannot_escape_the_runtime(self):
        deploy.runtime.private_json(self.root/"storage-json-current.json",{"schema":"hv-json-deployment/1","stateRoot":"/tmp","artifactRoot":"/tmp"})
        with self.assertRaisesRegex(RuntimeError,"escaped"):deploy.current_json(self.root)
    def test_generated_launchers_are_valid_and_sweeper_uses_common_configuration(self):
        deploy.wrappers(self.root)
        for name in ("run-api.sh","run-worker.sh","run-sweeper.sh","run-backup.sh"):
            subprocess.run(["bash","-n",str(self.root/name)],check=True)
        self.assertIn('source "$R/runtime-config.sh"',(self.root/"run-sweeper.sh").read_text())
        self.assertNotIn('source "$R/secrets.env"',(self.root/"run-backup.sh").read_text())
        self.assertIn('--slot "${1:-1}"',(self.root/"run-worker.sh").read_text())
    def test_unresolved_provider_export_keeps_postgres_active_and_does_not_restore_old_charges(self):
        with patch.object(deploy,"application",return_value=(self.root,"a"*40)),patch.object(deploy.runtime,"deployment",return_value=(self.manifest,self.root,self.root)),patch.object(deploy.runtime,"role_environment",return_value={}),patch.object(deploy,"drain"),patch.object(deploy,"execute",side_effect=RuntimeError("unresolved provider receipt")),patch.object(deploy,"control"):
            with self.assertRaisesRegex(RuntimeError,"unresolved"):deploy.rollback(self.root,self.root)
        self.assertEqual(json.loads(self.marker.read_text()),self.manifest)
        self.assertEqual(json.loads(self.ledger.read_text())[0]["total_cost_usd"],123.45)
        self.assertFalse((self.root/"storage-json-current.json").exists())
    def test_media_export_failure_cannot_switch_to_json(self):
        with patch.object(deploy,"application",return_value=(self.root,"a"*40)),patch.object(deploy.runtime,"deployment",return_value=(self.manifest,self.root,self.root)),patch.object(deploy.runtime,"role_environment",return_value={}),patch.object(deploy,"drain"),patch.object(deploy,"execute",side_effect=[None,RuntimeError("media checksum mismatch")]),patch.object(deploy,"control"):
            with self.assertRaisesRegex(RuntimeError,"checksum"):deploy.rollback(self.root,self.root)
        self.assertTrue(self.marker.exists());self.assertFalse((self.root/"storage-json-current.json").exists())
    def test_database_password_stays_in_environment_and_tls_verification_is_required(self):
        values={"HV_PG_ADMIN_URL":"postgres://hv_admin:fixture%2Bpassword@127.0.0.1:55432/source","HV_DATABASE_TLS_DIR":"/private/tls","HV_PG_LIB":"/bundled/lib"}
        environment=deploy.postgres_environment(values,"target")
        self.assertEqual(environment["PGPASSWORD"],"fixture+password")
        self.assertEqual(environment["PGSSLMODE"],"verify-full")
        self.assertEqual(environment["PGDATABASE"],"target")

if __name__=="__main__":unittest.main()
