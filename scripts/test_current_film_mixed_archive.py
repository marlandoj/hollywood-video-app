"""Isolated Python boundary tests; actual codecs and PG/S3 have separate fixtures."""
import copy, hashlib, importlib.util, json, os, subprocess, sys, tempfile, unittest, zipfile
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("archive_package",Path(__file__).with_name("archive-package.py"))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class MixedArchiveTests(unittest.TestCase):
    def write_scope(self,root,project,jobs,schema):
        bodies={"snapshot.json":{"schema":schema},"state/projects.json":{"version":1,"projects":[project],"reviewLinks":[],"takenDown":[],"takedownLog":[]},
            "queue/jobs.json":jobs,"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[]}
        for key,body in bodies.items():
            path=root/key; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(body))

    def test_all_older_schemas_reject_orphan_origins_and_nested_v3_markers(self):
        for marker in ({"currentFilmOrigins":None},{"schema":"hv-current-film-job/3"},{"schema":"hv-current-film-adoption/1"},{"schema":"hv-current-film-reuse-review/1"},{"schema":"hv-current-film-preview-review/3"}):
            for nested in (False,True):
                project={"id":"project","abandoned":[marker]} if nested else {"id":"project"}
                jobs=[] if nested else [{"id":"film","projectId":"project","status":"cancelled",**marker}]
                with tempfile.TemporaryDirectory() as temporary:
                    root=Path(temporary)
                    for version in range(1,14):
                        self.write_scope(root,project,jobs,"hv-state/"+str(version))
                        with self.assertRaisesRegex(ValueError,"schema 14"): module.project_scope(root,"project")
        self.assertFalse(module.current_film_mixed_contexts({"projects":[{"id":"project"}]},[]))
        self.assertFalse(module.current_film_mixed_contexts({},[{"currentFilm":{"schema":"hv-current-film-job/2"}}]))

    def test_schema_fourteen_bridge_validates_whole_snapshot_and_fails_closed(self):
        state={"projects":[{"id":"project"}]}; jobs=[{"currentFilmOrigins":{}}]; ledger={"events":[],"reservations":[]}
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],0,b"verified",b"")) as run:
            module.verify_current_screenplay(state,jobs,ledger,[],14); args,kwargs=run.call_args
            self.assertIn("validateSnapshot",args[0][2]); self.assertNotIn("shell",kwargs)
            self.assertEqual(json.loads(kwargs["input"]),{"schema":"hv-state/14","projects":state,"jobs":jobs,"ledger":ledger,"reviews":[]})
        with patch.dict(os.environ,{},clear=True),patch.object(module.shutil,"which",return_value=None):
            with self.assertRaisesRegex(ValueError,"schema 14.*requires Bun"): module.verify_current_screenplay(state,jobs,ledger,[],14)
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],1,b"",b"bad original")):
            with self.assertRaisesRegex(ValueError,"invalid sealed current screenplay"): module.verify_current_screenplay(state,jobs,ledger,[],14)

    def test_origins_only_and_positive_v3_prefix_use_fixed_bridge_without_public_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); jobs=[{"id":"film-"+str(count),"projectId":"project","status":"failed","checkpointShots":count,"checkpointFrame":count*30,
                "currentFilm":{"schema":"hv-current-film-job/3"},"currentFilmOrigins":{}} for count in (0,2)]
            with patch.object(module,"verify_assembly_metadata") as verify:
                module.verify_execution_media(root,"project",jobs); payload,code,schema,kind=verify.call_args.args
                self.assertEqual(payload,{"artifactRoot":str((root/"artifacts").resolve()),"jobs":jobs})
                self.assertEqual(schema,14); self.assertEqual(kind,"mixed current-film media")
                self.assertIn("verify-current-film-mixed-archive.ts",code); self.assertIn("verifyCurrentFilmMixedArchive(job,artifactRoot)",code)
                self.assertNotIn("validateCurrentFilmClips",code); self.assertFalse((root/"artifacts").exists())
            for count in (-1,61,True):
                with self.assertRaisesRegex(ValueError,"checkpoint count"): module.verify_execution_media(root,"project",[{**jobs[0],"checkpointShots":count}])

    def original_fixture(self,root,status="failed"):
        # These bytes isolate Python custody; the real metadata/media bridge is mocked.
        # They make no claim of a generated film or a successfully decoded WAV.
        def record(path,body): return {"path":path,"bytes":len(body),"sha256":hashlib.sha256(body).hexdigest()}
        bootstrap_body=b"bootstrap-picture"; bootstrap_file=record("project/bootstrap/export.mp4",bootstrap_body)
        bootstrap_job={"id":"bootstrap","projectId":"project","status":"done","output":{"mp4Path":bootstrap_file["path"]}}
        bootstrap={"schema":"hv-edit-source/1","job":bootstrap_job,"files":[bootstrap_file],"revision":"b"*64}
        originals=[record("project/original/export.mp4",b"source-picture"),record("project/original/clips/unselected.wav",b"unselected-native-pcm")]
        source={"schema":"hv-edit-source/3","revision":"a"*64,"job":{"id":"original","projectId":"project","status":"done","currentFilm":{"schema":"hv-current-film-job/2","library":{"origin":{"request":{"source":bootstrap}}}},"output":{"mp4Path":originals[0]["path"]}},"files":originals}
        prefix="project/mixed/originals/source-one/"
        copies=[{"original":file,"carrier":file,"owned":{**file,"path":prefix+file["path"]}} for file in originals]
        mixed={"id":"mixed","projectId":"project","status":status,"checkpointShots":0,"checkpointFrame":0,
            "currentFilm":{"schema":"hv-current-film-job/3","library":{"origin":{"request":{"source":bootstrap}}},"origins":[{"id":"source-one","binding":{"source":source}}]},
            "currentFilmOrigins":{"origins":[{"originId":"source-one","copies":copies}]}}
        bodies={bootstrap_file["path"]:bootstrap_body,copies[0]["owned"]["path"]:b"source-picture",copies[1]["owned"]["path"]:b"unselected-native-pcm"}
        for key,body in bodies.items():
            path=root/"artifacts"/key; path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(body)
        jobs=[bootstrap_job,mixed]; self.write_scope(root,{"id":"project"},jobs,"hv-state/14")
        return jobs,source,copies,bodies

    def test_internal_original_carrier_restores_unselected_roles_without_old_jobs(self):
        for status in ("failed","cancelled"):
            with self.subTest(status=status),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary); jobs,source,copies,bodies=self.original_fixture(root,status); before=(root/"queue/jobs.json").read_bytes()
                with patch.object(module,"verify_current_screenplay"),patch.object(module,"verify_current_film_mixed_media") as mixed,patch.object(module,"verify_current_source_media") as original:
                    self.assertEqual(module.project_scope(root,"project"),jobs); mixed.assert_called_once_with(root,[jobs[1]])
                    original.assert_called_once_with([{"job":source["job"],"artifactRoot":str((root/"artifacts/project/mixed/originals/source-one").resolve())}])
                    self.assertFalse((root/"artifacts/project/original").exists()); self.assertEqual((root/"queue/jobs.json").read_bytes(),before)
                    target=root/"artifacts"/copies[1]["owned"]["path"]
                    for missing in (False,True):
                        if missing: target.unlink()
                        else: target.write_bytes(b"x"*target.stat().st_size)
                        with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.project_scope(root,"project")
                        target.write_bytes(bodies[copies[1]["owned"]["path"]])
                    (root/"artifacts/project/bootstrap/export.mp4").unlink()
                    with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.project_scope(root,"project")

    def test_internal_mapping_rejects_missing_changed_or_foreign_prepared_originals(self):
        with tempfile.TemporaryDirectory() as temporary:
            jobs,_,_,_=self.original_fixture(Path(temporary))
            mutations=[lambda job:job["currentFilmOrigins"]["origins"].clear(),
                lambda job:job["currentFilmOrigins"]["origins"][0].update(originId="another"),
                lambda job:job["currentFilmOrigins"]["origins"][0]["copies"][0]["owned"].update(path="project/foreign/file.mp4"),
                lambda job:job["currentFilmOrigins"]["origins"][0]["copies"][0]["owned"].update(sha256="0"*64)]
            for change in mutations:
                altered=copy.deepcopy(jobs); change(altered[1])
                with self.assertRaises(ValueError): module.mixed_original_carriers(altered,"project")

    def test_reindexed_archive_missing_owned_original_fails_and_cleans_pending_unpack(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary); root=base/"source"; _,_,copies,_=self.original_fixture(root); archive=base/"mixed.zip"; omitted="artifacts/"+copies[1]["owned"]["path"]
            with patch.object(module,"verify_current_screenplay"),patch.object(module,"verify_current_film_mixed_media"),patch.object(module,"verify_current_source_media"):
                module.pack(root,archive,"project")
                with zipfile.ZipFile(archive) as saved: entries=[(info,saved.read(info)) for info in saved.infolist() if info.filename!=omitted]
                manifest=json.loads(entries[0][1]); manifest["files"]=[file for file in manifest["files"] if file["path"]!=omitted]; manifest["totalBytes"]=sum(file["bytes"] for file in manifest["files"])
                entries[0]=(entries[0][0],json.dumps(manifest).encode())
                with zipfile.ZipFile(archive,"w") as changed:
                    for info,body in entries: changed.writestr(info,body)
                with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.unpack(archive,base/"restored")
                self.assertFalse((base/"restored").exists()); self.assertEqual(list(base.glob("restored.*.pending")),[])

    def test_running_origins_are_not_a_drained_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); self.original_fixture(root,"running")
            with self.assertRaisesRegex(ValueError,"drained"): module.project_scope(root,"project")

    def test_large_output_exception_binds_exact_v3_path_size_digest_and_archive_total(self):
        # Lower only the test's historical per-file threshold, not production limits.
        # This exercises real ZIP pack/inspect/unpack without allocating GiB fixtures.
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary); root=base/"source"; jobs,_,_,_=self.original_fixture(root,"done")
            key="project/mixed/output/film.mp4"; body=b"measured-video"*2048; video={"bytes":len(body),"sha256":hashlib.sha256(body).hexdigest()}
            jobs[1]["output"]={"mp4Path":key,"currentFilm":{"schema":"hv-current-film-output/3","assembly":{"video":video}}}
            path=root/"artifacts"/key; path.parent.mkdir(parents=True); path.write_bytes(body); self.write_scope(root,{"id":"project"},jobs,"hv-state/14")
            with patch.object(module,"MAX_FILE_BYTES",8192),patch.object(module,"verify_current_screenplay") as metadata,patch.object(module,"verify_current_film_mixed_media"),patch.object(module,"verify_current_source_media"):
                large=module.large_current_film_outputs("hv-state/14",jobs,"project"); name="artifacts/"+key
                self.assertTrue(module.archive_file_size(name,len(body),large,video["sha256"]))
                self.assertFalse(module.archive_file_size(name,len(body)-1,large,video["sha256"]))
                self.assertFalse(module.archive_file_size(name,len(body),large,"0"*64))
                self.assertFalse(module.archive_file_size(name+".wav",len(body),large,video["sha256"]))
                self.assertEqual(module.large_current_film_outputs("hv-state/13",jobs,"project"),{})
                archive=base/"large.zip"; module.pack(root,archive,"project"); metadata.reset_mock()
                with zipfile.ZipFile(archive) as saved: module.inspect(saved)
                metadata.assert_called_once(); self.assertEqual(metadata.call_args.args[-1],14)
                module.unpack(archive,base/"restored"); self.assertEqual((base/"restored/artifacts"/key).read_bytes(),body)
                with patch.object(module,"MAX_TOTAL_BYTES",len(body)-1):
                    with self.assertRaisesRegex(ValueError,"large mixed-film|size"): module.pack(root,base/"over-total.zip","project")

if __name__=="__main__": unittest.main()
