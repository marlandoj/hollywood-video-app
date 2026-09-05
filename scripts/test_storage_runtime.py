import importlib.util
import json
from pathlib import Path
import shlex
import tempfile
import unittest

spec=importlib.util.spec_from_file_location("runtime_launch",Path(__file__).with_name("storage-runtime-launch.py"))
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix="hv-runtime-")
        self.root=Path(self.temporary.name);self.platform=self.root/"platform";self.platform.mkdir()
        app=self.root/"releases"/("a"*40);app.mkdir(parents=True);(app/".deployed-sha").write_text("a"*40)
        (self.root/"active-release.txt").write_text(str(app))
        for name in ("run-api.sh","run-worker.sh","run-sweeper.sh","run-backup.sh","bin/bun"):
            path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text("fixture")
        self.manifest={"schema":"hv-storage-deployment/1","backend":"postgres","workers":3,"database":"hollywood_video_staging",
            "bucket":"rough-cut-staging","releaseSha":"a"*40,"platformRoot":str(self.platform),"backupRepository":str(self.platform/"backups/staging")}
        runtime.private_json(self.root/"storage-deployment.json",self.manifest)
        for role,key in runtime.ROLES.items():
            user={"api":"hv_api","worker":"hv_worker","sweeper":"hv_worker","backup":"hv_admin"}[role]
            values={key:"postgres://"+user+":fixture-only@127.0.0.1:55432/hollywood_video_staging","HV_DATABASE_TLS_DIR":str(self.platform/"tls"),
                "HV_S3_ENDPOINT":"https://127.0.0.1:59000","HV_S3_BUCKET":"rough-cut-staging","HV_S3_REGION":"us-east-1",
                "HV_S3_ACCESS_KEY_ID":"fixture","HV_S3_SECRET_ACCESS_KEY":"fixture-only"}
            path=self.root/("storage-"+role+".env");path.write_text("\n".join(key+"="+shlex.quote(value) for key,value in values.items())+"\n");path.chmod(0o600)
    def tearDown(self):self.temporary.cleanup()
    def test_deployment_binds_immutable_release_and_backup_location(self):
        self.assertEqual(runtime.deployment(self.root)[0],self.manifest)
        (self.root/"active-release.txt").write_text(str(self.platform))
        with self.assertRaisesRegex(RuntimeError,"immutable"):runtime.deployment(self.root)
    def test_readiness_cannot_survive_a_new_boot_or_changed_deployment(self):
        runtime.private_json(self.root/"storage-ready.json",{"schema":"hv-storage-ready/1","bootId":"boot-one","deploymentSha256":runtime.fingerprint(self.manifest)})
        self.assertTrue(runtime.ready(self.root,self.manifest,"boot-one"))
        self.assertFalse(runtime.ready(self.root,self.manifest,"boot-two"))
        self.assertFalse(runtime.ready(self.root,{**self.manifest,"database":"changed"},"boot-one"))
    def test_role_environments_do_not_leak_admin_connector_or_signing_credentials(self):
        inherited={"PATH":"/usr/bin:/bin","FAL_KEY":"provider-secret","LINEAR_API_KEY":"connector-secret","HV_PG_ADMIN_URL":"admin-secret",
            "HV_TOKEN_SECRET":"project-signing-secret","HV_OPERATOR_GRANT_SECRET":"operator-signing-secret","HV_MONTHLY_BUDGET_USD":"500"}
        api=runtime.role_environment(self.root,"api",self.manifest,inherited)
        self.assertNotIn("HV_PG_ADMIN_URL",api);self.assertNotIn("FAL_KEY",api);self.assertNotIn("LINEAR_API_KEY",api)
        self.assertEqual(api["HV_TOKEN_SECRET"],"project-signing-secret")
        worker=runtime.role_environment(self.root,"worker",self.manifest,inherited)
        self.assertEqual(worker["FAL_KEY"],"provider-secret");self.assertNotIn("HV_TOKEN_SECRET",worker)
        self.assertNotIn("HV_OPERATOR_GRANT_SECRET",worker);self.assertNotIn("HV_PG_ADMIN_URL",worker)
        for role in ("sweeper","backup"):
            env=runtime.role_environment(self.root,role,self.manifest,inherited)
            for key in ("FAL_KEY","HV_TOKEN_SECRET","HV_OPERATOR_GRANT_SECRET","LINEAR_API_KEY"):self.assertNotIn(key,env)
    def test_wrong_role_or_public_environment_permissions_are_refused(self):
        path=self.root/"storage-api.env"
        path.write_text(path.read_text()+"HV_PG_ADMIN_URL=forbidden\n")
        with self.assertRaisesRegex(RuntimeError,"unexpected variable"):runtime.role_environment(self.root,"api",self.manifest)
        path.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError,"private"):runtime.role_environment(self.root,"api",self.manifest)
    def test_supervisor_changes_preserve_other_services_and_allow_parent_first_drain(self):
        unrelated='[program:unrelated]\ncommand=/other/service\nenvironment=TOKEN="keep-this-verbatim"\n'
        current=unrelated+'[program:rough-cut-staging-worker]\ncommand=bash '+str(self.root/'run-worker.sh')+'\nstopasgroup=true\nkillasgroup=true\nstopwaitsecs=4\n'
        updated,changed=runtime.managed_configuration(current,self.root)
        self.assertTrue(updated.startswith(unrelated));self.assertEqual(set(changed),set(runtime.PROGRAMS))
        self.assertIn('stopasgroup=false',updated);self.assertIn('stopwaitsecs=900',updated);self.assertIn('stopwaitsecs=600',updated)
        self.assertEqual(runtime.managed_configuration(updated,self.root),(updated,[]))
    def test_conflicting_service_command_is_not_replaced(self):
        with self.assertRaisesRegex(RuntimeError,"another command"):
            runtime.managed_configuration('[program:rough-cut-staging-worker]\ncommand=/someone/else\n',self.root)

if __name__=="__main__":unittest.main()
