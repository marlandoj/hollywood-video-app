"""Schema/ZIP custody boundaries; real codec and PG/S3 fixtures qualify separately."""
import copy, hashlib, importlib.util, json, os, subprocess, sys, tempfile, unittest, zipfile
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("archive_package",Path(__file__).with_name("archive-package.py"))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class ProofArchiveTests(unittest.TestCase):
    def write_scope(self,root,project,jobs,schema="hv-state/15"):
        bodies={"snapshot.json":{"schema":schema},"state/projects.json":{"version":1,"projects":[project],"reviewLinks":[],"takenDown":[],"takedownLog":[]},
            "queue/jobs.json":jobs,"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[]}
        for key,body in bodies.items():
            path=root/key; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(body))

    def fixture(self,root):
        body=b"original-source-custody"; original={"path":"project/original/output/film.mp4","sha256":hashlib.sha256(body).hexdigest(),"bytes":len(body)}
        receipt={"schema":"hv-edit-source/1","revision":"a"*64,"job":{"id":"original","projectId":"project","status":"done","output":{"mp4Path":original["path"]}},"files":[original]}
        owned={**original,"path":"project/mixed/proof/originals/"+receipt["revision"]+"/"+original["path"]}
        specification={"schema":"hv-current-film-proof-copies/1","frozenContext":{"project":{"id":"project","source":receipt},"jobs":[]},
            "carriers":[{"receiptRevision":receipt["revision"],"copies":[{"original":original,"owned":owned}]}],"previews":[],"references":[]}
        job={"id":"mixed","projectId":"project","status":"failed","checkpointShots":0,"checkpointFrame":0,
            "currentFilm":{"schema":"hv-current-film-job/3","library":{"origin":{"request":{"source":receipt}}}},
            "currentFilmProof":{"schema":"hv-current-film-prepared-proof/1","specification":specification}}
        path=root/"artifacts"/owned["path"]; path.parent.mkdir(parents=True); path.write_bytes(body)
        self.write_scope(root,{"id":"project"},[job]); return job,receipt,owned,body

    def test_all_older_schemas_reject_proof_markers_including_abandoned_branches(self):
        for marker in ({"currentFilmProof":None},{"schema":"hv-current-film-prepared-proof/1"},{"schema":"hv-current-film-proof-copies/1"},{"schema":"hv-current-film-proof-target/1"},{"schema":"hv-current-film-proof-closure/1"}):
            for nested in (False,True):
                project={"id":"project","abandoned":[marker]} if nested else {"id":"project"}
                jobs=[] if nested else [{"id":"film","projectId":"project","status":"cancelled",**marker}]
                with tempfile.TemporaryDirectory() as temporary:
                    root=Path(temporary)
                    for version in range(1,15):
                        self.write_scope(root,project,jobs,"hv-state/"+str(version))
                        with self.assertRaisesRegex(ValueError,"schema 15"): module.project_scope(root,"project")
        self.assertFalse(module.current_film_proof_contexts({},[{"currentFilmOrigins":{}}]))

    def test_schema_fifteen_replays_exact_snapshot_and_fails_closed(self):
        state={"projects":[{"id":"project"}]}; jobs=[{"currentFilmProof":{}}]; ledger={"events":[],"reservations":[]}
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],0,b"verified",b"")) as run:
            module.verify_current_screenplay(state,jobs,ledger,[],15); args,kwargs=run.call_args
            self.assertIn("validateSnapshot",args[0][2]); self.assertNotIn("shell",kwargs)
            self.assertEqual(json.loads(kwargs["input"]),{"schema":"hv-state/15","projects":state,"jobs":jobs,"ledger":ledger,"reviews":[]})
        with patch.dict(os.environ,{},clear=True),patch.object(module.shutil,"which",return_value=None):
            with self.assertRaisesRegex(ValueError,"schema 15.*requires Bun"): module.verify_current_screenplay(state,jobs,ledger,[],15)
        with patch.dict(os.environ,{"HV_BUN_PATH":sys.executable}),patch.object(module.subprocess,"run",return_value=subprocess.CompletedProcess([],1,b"",b"changed proof")):
            with self.assertRaisesRegex(ValueError,"invalid sealed current screenplay"): module.verify_current_screenplay(state,jobs,ledger,[],15)

    def test_proof_only_uses_fixed_media_bridge_without_a_legacy_clip_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); job,_,_,_=self.fixture(root)
            with patch.object(module,"verify_assembly_metadata") as verify:
                module.verify_execution_media(root,"project",[job]); payload,code,schema,kind=verify.call_args.args
                self.assertEqual(payload,{"artifactRoot":str((root/"artifacts").resolve()),"jobs":[job]}); self.assertEqual(schema,15)
                self.assertIn("verifyCurrentFilmMixedArchive",code); self.assertEqual(kind,"mixed current-film media")

    def test_owned_proof_retains_original_without_top_level_job_and_rejects_missing_or_corrupt_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); job,receipt,owned,body=self.fixture(root)
            with patch.object(module,"verify_current_screenplay"),patch.object(module,"verify_current_film_mixed_media"):
                self.assertEqual(module.project_scope(root,"project"),[job]); self.assertFalse((root/"artifacts/project/original").exists())
                retained=module.proof_original_carriers([job],"project"); self.assertEqual(retained[0][1]["receipt"],receipt); self.assertEqual(retained[0][2],[owned])
                path=root/"artifacts"/owned["path"]
                for missing in (True,False):
                    if missing: path.unlink()
                    else: path.write_bytes(b"x"*len(body))
                    with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.project_scope(root,"project")
                    path.write_bytes(body)

    def test_internal_proof_mapping_requires_exact_receipt_namespace_and_full_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            job,_,_,_=self.fixture(Path(temporary))
            for change in (lambda spec:spec["carriers"][0]["copies"].clear(),lambda spec:spec["carriers"][0].update(receiptRevision="b"*64),
                lambda spec:spec["carriers"][0]["copies"][0]["owned"].update(path="project/foreign/film.mp4"),
                lambda spec:spec["carriers"][0]["copies"][0]["owned"].update(sha256="0"*64)):
                altered=copy.deepcopy(job); change(altered["currentFilmProof"]["specification"])
                with self.assertRaises(ValueError): module.proof_original_carriers([altered],"project")

    def test_direct_plan_only_receipt_maps_exact_proof_bytes_without_a_top_level_source_job(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary); root=base/"source"; job,receipt,owned,body=self.fixture(root)
            # Match the real ownership shape: the selected /3 receipt is in the
            # V3 plan, while frozenContext retains its original job, not a copy
            # of that inspection receipt in an invented project.source field.
            bootstrap=copy.deepcopy(receipt); bootstrap["revision"]="b"*64; bootstrap["job"]["id"]="bootstrap"
            bootstrap["files"][0]["path"]="project/bootstrap/output/film.mp4"; bootstrap["job"]["output"]["mp4Path"]=bootstrap["files"][0]["path"]
            receipt["schema"]="hv-edit-source/3"
            receipt["job"]["currentFilm"]={"schema":"hv-current-film-job/2","library":{"origin":{"request":{"source":bootstrap}}}}
            job["currentFilm"]={"schema":"hv-current-film-job/3","library":{"origin":{"request":{"source":bootstrap}}},
                "origins":[{"id":receipt["revision"],"binding":{"source":receipt}}]}
            specification=job["currentFilmProof"]["specification"]
            specification["frozenContext"]={"project":{"id":"project"},"jobs":[copy.deepcopy(receipt["job"]),copy.deepcopy(bootstrap["job"])]}
            original=bootstrap["files"][0]; bootstrap_owned={**original,"path":"project/mixed/proof/originals/"+bootstrap["revision"]+"/"+original["path"]}
            specification["carriers"].append({"receiptRevision":bootstrap["revision"],"copies":[{"original":original,"owned":bootstrap_owned}]})
            bootstrap_path=root/"artifacts"/bootstrap_owned["path"]; bootstrap_path.parent.mkdir(parents=True); bootstrap_path.write_bytes(body)
            self.write_scope(root,{"id":"project"},[job]); before=copy.deepcopy(job)
            mapped=module.proof_original_carriers([job],"project")
            self.assertEqual(mapped[0][1]["receipt"],receipt); self.assertEqual(mapped[0][2],[owned]); self.assertEqual(job,before)
            # Codec and complete sealed-plan validation remain separate gates;
            # this unit exercises only Python's mapping and ZIP custody path.
            with patch.object(module,"verify_current_screenplay"),patch.object(module,"verify_current_film_mixed_media"),patch.object(module,"verify_current_source_media"):
                archive=base/"proof.zip"; destination=base/"restored"
                module.pack(root,archive,"project"); module.unpack(archive,destination)
                self.assertEqual((destination/"artifacts"/owned["path"]).read_bytes(),body)
                self.assertFalse((destination/"artifacts/project/original").exists())
                self.assertFalse((destination/"artifacts/project/bootstrap").exists())
                self.assertEqual(json.loads((destination/"queue/jobs.json").read_text()),[job])

    def test_direct_plan_and_frozen_context_cannot_disagree_under_the_same_receipt_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            job,receipt,_,_=self.fixture(Path(temporary))
            job["currentFilm"]["origins"]=[{"id":receipt["revision"],"binding":{"source":copy.deepcopy(receipt)}}]
            # Identical repeated receipts across the two validated scopes are
            # legitimate; any same-seal body disagreement must fail closed.
            self.assertEqual(len(module.proof_original_carriers([job],"project")),1)
            changed=copy.deepcopy(job)
            changed["currentFilmProof"]["specification"]["frozenContext"]["project"]["source"]["files"][0]["sha256"]="f"*64
            with self.assertRaisesRegex(ValueError,"proof source identities disagree"):
                module.proof_original_carriers([changed],"project")
            changed=copy.deepcopy(job)
            changed["currentFilm"]["origins"][0]["binding"]["source"]["job"]["id"]="other-original"
            with self.assertRaisesRegex(ValueError,"proof source identities disagree"):
                module.proof_original_carriers([changed],"project")

    def test_reindexed_zip_cannot_omit_required_proof_and_unpack_cleans_pending_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary); root=base/"source"; _,_,owned,_=self.fixture(root); archive=base/"proof.zip"; omitted="artifacts/"+owned["path"]
            with patch.object(module,"verify_current_screenplay"),patch.object(module,"verify_current_film_mixed_media"):
                module.pack(root,archive,"project")
                with zipfile.ZipFile(archive) as saved: entries=[(info,saved.read(info)) for info in saved.infolist() if info.filename!=omitted]
                manifest=json.loads(entries[0][1]); manifest["files"]=[file for file in manifest["files"] if file["path"]!=omitted]; manifest["totalBytes"]=sum(file["bytes"] for file in manifest["files"])
                entries[0]=(entries[0][0],json.dumps(manifest).encode())
                with zipfile.ZipFile(archive,"w") as changed:
                    for info,body in entries: changed.writestr(info,body)
                with self.assertRaisesRegex(ValueError,"missing or corrupt"): module.unpack(archive,base/"restored")
                self.assertFalse((base/"restored").exists()); self.assertEqual(list(base.glob("restored.*.pending")),[])

    def test_large_proof_preview_exception_binds_only_its_measured_owned_mp4(self):
        with tempfile.TemporaryDirectory() as temporary:
            job,_,_,_=self.fixture(Path(temporary)); proof=job["currentFilmProof"]["specification"]
            original={"path":"project/preview/output/film.mp4","bytes":10000,"sha256":"d"*64}; owned={**original,"path":"project/mixed/proof/previews/preview/"+original["path"]}
            proof["previews"]=[{"jobId":"preview","copies":[{"original":original,"owned":owned}]}]
            proof["frozenContext"]["jobs"]=[{"id":"preview","output":{"mp4Path":original["path"],"currentFilm":{"schema":"hv-current-film-output/2","assembly":{"video":{"bytes":10000,"sha256":"d"*64}}}}}]
            with patch.object(module,"MAX_FILE_BYTES",8192):
                large=module.large_current_film_outputs("hv-state/15",[job],"project"); key="artifacts/"+owned["path"]
                self.assertTrue(module.archive_file_size(key,10000,large,"d"*64)); self.assertFalse(module.archive_file_size(key,10001,large,"d"*64))
                self.assertFalse(module.archive_file_size(key,10000,large,"a"*64)); self.assertFalse(module.archive_file_size(key+".wav",10000,large,"d"*64))
                self.assertEqual(module.large_current_film_outputs("hv-state/14",[job],"project"),{})
                owned["sha256"]="a"*64
                with self.assertRaisesRegex(ValueError,"measured original"): module.large_current_film_outputs("hv-state/15",[job],"project")

if __name__=="__main__": unittest.main()
