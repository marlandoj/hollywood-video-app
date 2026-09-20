import importlib.util
import io
import json
import os
import re
from pathlib import Path
import subprocess
import tarfile
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
    def test_writable_rollback_data_is_separate_from_verified_snapshot(self):
        snapshot=self.root/"snapshot";snapshot.mkdir();(snapshot/"state").mkdir();(snapshot/"queue").mkdir()
        (snapshot/"snapshot.json").write_text('{"schema":"hv-state/1","files":{"state/projects.json":"fixed-checksum"}}')
        (snapshot/"state/projects.json").write_text("original");(snapshot/"queue/jobs.json").write_text("[]")
        live=deploy.mutable_json_copy(snapshot,self.root/"live-json")
        (live/"state/projects.json").write_text("new project after rollback")
        self.assertFalse((live/"snapshot.json").exists())
        self.assertEqual((snapshot/"state/projects.json").read_text(),"original")
        self.assertTrue((snapshot/"snapshot.json").exists())
        with self.assertRaisesRegex(RuntimeError,"already exists"):deploy.mutable_json_copy(snapshot,live)
    def test_runtime_symlink_is_refused_before_deployment_preparation(self):
        (self.root/"bin").mkdir();(self.root/"bin/bun").symlink_to(self.ledger)
        with self.assertRaisesRegex(RuntimeError,"not regular"):deploy.application(self.root,self.root)
    def test_legacy_release_tool_refuses_current_rollback_paths(self):
        module_spec=importlib.util.spec_from_file_location("legacy",Path(__file__).with_name("deploy-private-staging.py"))
        legacy=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(legacy)
        self.marker.unlink()
        (self.root/"storage-json-current.json").write_text("{}")
        with self.assertRaisesRegex(RuntimeError,"exported JSON"):legacy.require_json_backend(self.root)
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
    def test_git_archive_release_can_bootstrap_observability_without_group_write(self):
        module_spec=importlib.util.spec_from_file_location("release_files",Path(__file__).with_name("deploy-private-staging.py"))
        legacy=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(legacy)
        observation_spec=importlib.util.spec_from_file_location("observation",Path(__file__).with_name("observability-runtime.py"))
        observation=importlib.util.module_from_spec(observation_spec);observation_spec.loader.exec_module(observation)
        repo=self.root/"source";repo.mkdir();(repo/"scripts").mkdir();(repo/"infra/observability").mkdir(parents=True)
        names=["scripts/observability-runtime.py","scripts/host_config.py","scripts/install-observability-runtime.py",*["infra/observability/"+name+".yaml" for name in observation.SERVICES]]
        for name in names:(repo/name).write_text("fixture "+name+"\n")
        (repo/"scripts/executable.sh").write_text("#!/bin/sh\nexit 0\n");(repo/"scripts/executable.sh").chmod(0o755)
        def git(*arguments):return subprocess.check_output(["git","-C",str(repo),*arguments],stderr=subprocess.DEVNULL)
        git("init");git("config","tar.umask","0002");git("add",".")
        git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture")
        git("update-ref","refs/remotes/origin/main","HEAD")
        with tarfile.open(fileobj=io.BytesIO(git("archive","HEAD"))) as archive:
            self.assertTrue(archive.getmember(names[0]).mode & 0o020)
        (self.root/"secrets.env").write_text("")
        (self.root/"bin").mkdir();binary=self.root/"bin/bun"
        original_run=legacy.run
        def run(*arguments,**kwargs):
            if arguments[0]==str(binary):return subprocess.CompletedProcess(arguments,0)
            return original_run(*arguments,**kwargs)
        previous_umask=os.umask(0o002)
        try:
            with patch.object(legacy.shutil,"which",return_value="/fixture/tool"),patch.object(legacy,"run",side_effect=run):
                release,identity=legacy.prepare_release(self.root.resolve(),repo,"HEAD")
        finally:os.umask(previous_umask)
        selected,files=observation.source_files(release)
        self.assertEqual(selected,identity);self.assertEqual(files,{name:(repo/name).read_bytes() for name in names})
        self.assertEqual((release/"scripts/executable.sh").stat().st_mode & 0o777,0o755)
        for path in [release,*release.rglob("*")]:self.assertEqual(path.stat().st_mode & 0o022,0)


# HV-032-04: a new staging host is provisioned from the repository, in Zo's runtime shape.
provision_spec=importlib.util.spec_from_file_location("provision",Path(__file__).with_name("provision-staging-host.py"))
provision=importlib.util.module_from_spec(provision_spec);provision_spec.loader.exec_module(provision)
private_spec=importlib.util.spec_from_file_location("private_deploy",Path(__file__).with_name("deploy-private-staging.py"))
private_deploy=importlib.util.module_from_spec(private_spec);private_spec.loader.exec_module(private_deploy)


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="hv-provision-");base=Path(self.temp.name)
        self.root,self.platform,self.config=base/"staging",base/"platform",base/"etc/supervisord.conf"
        self.bun=base/"bun";self.bun.write_text("#!/bin/sh\necho 1.4.0\n");self.bun.chmod(0o755)
        self.operator=base/"operator.env"
        self.operator.write_text("FAL_KEY=fal-key-value-0123456789abcdef\n\nHV_AZURE_SPEECH_KEY=azure-key-value-0123456789\nOTHER=ignored\n")
        self.operator.chmod(0o600)
    def tearDown(self):self.temp.cleanup()
    def run_provision(self):
        report=provision.Report()
        provision.provision(self.root,self.platform,self.config,self.bun,self.operator,"http://localhost:8081",False,report)
        return report

    def test_the_supervisor_exports_the_settings_every_script_reads(self):
        text=provision.supervisor_base(Path("/etc/rough-cut/supervisord.conf"))
        self.assertIn("[inet_http_server]\nport=127.0.0.1:",text)
        self.assertIn('HV_SUPERVISOR_CONFIG="/etc/rough-cut/supervisord.conf"',text)
        url=text.split('HV_SUPERVISOR_RPC_URL="')[1].split('"')[0]
        self.assertEqual(provision.host_config.supervisor_rpc_url({"HV_SUPERVISOR_RPC_URL":url}),url)
        self.assertEqual(url,provision.host_config.ZO_SUPERVISOR_RPC_URL)

    def test_runtime_configuration_is_the_one_deploy_writes_and_is_mock_only(self):
        source=Path(private_deploy.__file__).read_text()
        self.assertIn(provision.RUNTIME_CONFIG,source)
        for line in provision.RUNTIME_CONFIG.splitlines():
            if re.search(r"_PROVIDER(_PRIMARY|_SECONDARY)?=",line): self.assertTrue(line.endswith("=mock"),line)
        self.assertIn("HV_MONTHLY_BUDGET_USD=500\n",provision.RUNTIME_CONFIG)

    def test_wrappers_are_the_ones_a_storage_cutover_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            deploy.wrappers(Path(directory))
            for name in ("run-api.sh","run-worker.sh","run-sweeper.sh","run-backup.sh"):
                self.assertEqual(provision.WRAPPERS[name],(Path(directory)/name).read_text(),name)

    def test_programs_keep_the_edge_on_loopback_and_give_workers_time_to_finish(self):
        sections=provision.programs(Path("/srv/rc"),"https://review.example")
        self.assertEqual(set(sections),{"rough-cut-staging-api","rough-cut-staging-worker","rough-cut-staging-sweeper","rough-cut-staging-edge"})
        self.assertIn('HV_EDGE_HOSTNAME="127.0.0.1"',sections["rough-cut-staging-edge"])
        self.assertIn("stopwaitsecs=900",sections["rough-cut-staging-worker"])
        self.assertIn('HV_FRONTEND_ORIGIN="https://review.example"',sections["rough-cut-staging-api"])
        self.assertEqual(set(sections),set(deploy.BASE))

    def test_an_empty_host_becomes_a_complete_runtime(self):
        report=self.run_provision()
        for name in ("bin/bun","edge/edge.ts","run-api.sh","run-worker.sh","run-sweeper.sh","run-backup.sh","run-edge.sh",
                     "runtime-config.sh","secrets.env","mtls/ca/ca.crt","mtls/api/api.crt","mtls/api/api.key","mtls/api/ca.crt",
                     "mtls/frontend/frontend.crt","mtls/frontend/frontend.key","mtls/frontend/ca.crt","data/queue","data/state","data/artifacts"):
            self.assertTrue((self.root/name).exists(),name)
        self.assertEqual((self.root/"edge/edge.ts").read_text(),(Path(__file__).parent.parent/"infra/staging/edge.ts").read_text())
        for name in ("secrets.env","run-api.sh","runtime-config.sh","mtls/api/api.key","mtls/frontend/frontend.key","mtls/ca/ca.key"):
            self.assertEqual((self.root/name).stat().st_mode & 0o077,0,name)
        self.assertEqual(self.config.stat().st_mode & 0o077,0)
        config=self.config.read_text()
        for name in deploy.BASE: self.assertEqual(config.count(f"[program:{name}]"),1)
        self.assertTrue(report.created)
        # A storage cutover snapshots the JSON source before any project exists; the state file must be there.
        self.assertEqual(json.loads((self.root/"data/state/projects.json").read_text()),provision.EMPTY_PROJECT_STATE)

    def test_secrets_carry_the_operator_keys_by_name_and_a_fresh_token_secret(self):
        self.run_provision()
        values=deploy.env_file(self.root/"secrets.env")
        self.assertEqual(set(values),{"HV_TOKEN_SECRET","FAL_KEY","HV_AZURE_SPEECH_KEY"})
        self.assertRegex(values["HV_TOKEN_SECRET"],r"^[a-f0-9]{64}$")
        self.assertEqual(values["FAL_KEY"],"fal-key-value-0123456789abcdef")

    def test_nothing_secret_is_printed(self):
        result=subprocess.run(["python3",str(Path(__file__).with_name("provision-staging-host.py")),"--root",str(self.root),
            "--platform",str(self.platform),"--supervisor-config",str(self.config),"--bun",str(self.bun),
            "--operator-secrets",str(self.operator),"--no-systemd"],capture_output=True,text=True,check=True)
        secret=deploy.env_file(self.root/"secrets.env")
        for value in secret.values(): self.assertNotIn(value,result.stdout+result.stderr)
        self.assertEqual(json.loads(result.stdout)["providerKeysCopied"],["FAL_KEY","HV_AZURE_SPEECH_KEY"])

    def test_a_second_run_overwrites_nothing(self):
        self.run_provision()
        before={path:path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        config=self.config.read_text()
        report=self.run_provision()
        self.assertEqual(report.created,[])
        self.assertEqual({path:path.read_bytes() for path in self.root.rglob("*") if path.is_file()},before)
        self.assertEqual(self.config.read_text(),config)

    def test_the_identities_chain_to_the_private_ca_with_the_right_purposes(self):
        self.run_provision()
        ca=str(self.root/"mtls/ca/ca.crt")
        for cert,purpose in (("mtls/api/api.crt","sslserver"),("mtls/frontend/frontend.crt","sslclient")):
            result=subprocess.run(["openssl","verify","-purpose",purpose,"-CAfile",ca,str(self.root/cert)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        wrong=subprocess.run(["openssl","verify","-purpose","sslserver","-CAfile",ca,str(self.root/"mtls/frontend/frontend.crt")],capture_output=True,text=True)
        self.assertNotEqual(wrong.returncode,0)

    def test_refusals(self):
        self.operator.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError,"group or others"):self.run_provision()
        self.assertFalse(self.root.exists())
        self.assertFalse(self.config.exists())
        self.operator.chmod(0o600);self.operator.write_text("FAL_KEY=two words\n")
        with self.assertRaisesRegex(ValueError,"single word"):self.run_provision()
        self.operator.write_text("FAL_KEY=ok-value\n")
        link=self.bun.with_name("bun-link");link.symlink_to(self.bun);self.bun=link
        with self.assertRaisesRegex(RuntimeError,"not a link"):self.run_provision()
        wrong=self.bun.with_name("bun-old");wrong.write_text("#!/bin/sh\necho 1.3.9\n");wrong.chmod(0o755);self.bun=wrong
        with self.assertRaisesRegex(RuntimeError,"Bun 1.4.0"):self.run_provision()
        self.assertFalse((self.root/"bin/bun").exists())
        with self.assertRaisesRegex(RuntimeError,"absolute"):
            provision.provision(Path("relative"),self.platform,self.config,self.bun,self.operator,"x",False,provision.Report())

providers_spec=importlib.util.spec_from_file_location("staging_providers",Path(__file__).with_name("staging-providers.py"))
providers=importlib.util.module_from_spec(providers_spec);providers_spec.loader.exec_module(providers)

class ProviderProfileTests(unittest.TestCase):
    """HV-019-05: the operator picks a provider profile from a fixed table; caps never move."""
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="hv-providers-");self.root=Path(self.temp.name)
        (self.root/"runtime-config.sh").write_text(deploy.common(Path("/srv/state"),Path("/srv/media"))+"export HV_PROVIDER_POOL='[\"mock\"]'\n")
        (self.root/"secrets.env").write_text("HV_TOKEN_SECRET=x\n")
    def tearDown(self):self.temp.cleanup()
    def exports(self):
        return dict(line[7:].split("=",1) for line in (self.root/"runtime-config.sh").read_text().splitlines() if line.startswith("export "))

    def test_every_deploy_writes_the_mock_profile(self):
        self.assertEqual(providers.current_profile(deploy.common(Path("/a"),Path("/b"))),"mock")
        self.assertEqual(providers.current_profile(provision.RUNTIME_CONFIG),"mock")

    def test_a_live_profile_needs_the_operators_fal_key_and_changes_nothing_without_it(self):
        before=(self.root/"runtime-config.sh").read_text()
        with self.assertRaisesRegex(RuntimeError,"FAL_KEY"):providers.apply(self.root,"live-storyboards")
        (self.root/"secrets.env").write_text("FAL_KEY=short\n")
        with self.assertRaisesRegex(RuntimeError,"FAL_KEY"):providers.apply(self.root,"live-film")
        self.assertEqual((self.root/"runtime-config.sh").read_text(),before)
        self.assertFalse((self.root/"provider-profile.json").exists())

    def test_only_provider_lines_change_and_every_cap_is_kept(self):
        before=self.exports()
        (self.root/"secrets.env").write_text("FAL_KEY=fal-key-value-0123456789abcdef\n")
        record=providers.apply(self.root,"live-film")
        after=self.exports();text=(self.root/"runtime-config.sh").read_text()
        self.assertEqual(after["HV_ANIMATIC_PROVIDER"],"image:fal:flux-schnell")
        self.assertEqual(after["HV_PROVIDER_PRIMARY"],"fal:kling-v2.5-turbo-pro")
        self.assertNotIn("HV_PROVIDER_POOL",after)
        for key,value in before.items():
            if key not in providers.PROVIDER_KEYS+providers.POOL_KEYS:self.assertEqual(after[key],value,key)
        self.assertEqual(after["HV_MONTHLY_BUDGET_USD"],"500")
        self.assertNotIn("fal-key-value",text);self.assertNotIn("fal-key-value",json.dumps(record))
        self.assertEqual(record["previous"],"custom");self.assertEqual(record["profile"],"live-film")
        self.assertEqual(os.stat(self.root/"runtime-config.sh").st_mode&0o777,0o600)
        self.assertEqual(providers.current_profile(text),"live-film")

    def test_the_anchored_profile_starts_finals_from_a_frame_and_keeps_a_text_fallback(self):
        (self.root/"secrets.env").write_text("FAL_KEY=fal-key-value-0123456789abcdef\n")
        providers.apply(self.root,"live-film-anchored");after=self.exports()
        self.assertEqual(after["HV_PROVIDER_PRIMARY"],"fal:kling-o3-standard-keyframes")
        self.assertEqual(after["HV_PROVIDER_SECONDARY"],"fal:kling-v2.5-turbo-pro")
        self.assertEqual(after["HV_ANIMATIC_PROVIDER"],"image:fal:flux-schnell")
        self.assertEqual(after["HV_MONTHLY_BUDGET_USD"],"500")

    def test_back_to_mock_needs_no_key_and_unknown_profiles_are_refused(self):
        (self.root/"secrets.env").write_text("FAL_KEY=fal-key-value-0123456789abcdef\n")
        providers.apply(self.root,"live-storyboards")
        (self.root/"secrets.env").write_text("")
        self.assertEqual(providers.apply(self.root,"mock")["previous"],"live-storyboards")
        self.assertEqual(providers.current_profile((self.root/"runtime-config.sh").read_text()),"mock")
        with self.assertRaises(ValueError):providers.apply(self.root,"fal:anything")
        with self.assertRaises(ValueError):providers.render("","live-everything")

if __name__=="__main__":unittest.main()
