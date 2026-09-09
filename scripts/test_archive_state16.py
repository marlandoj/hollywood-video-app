"""Draft Python dispatch/mapping tests, not native media or sealed-job evidence.

After application this belongs at scripts/test_archive_state16.py. These small
synthetic dictionaries exercise Python guards only; real TS, native and service
qualification is mandatory and cannot be replaced by the mocks below.
"""
import copy, hashlib, importlib.util, json, tempfile, unittest, zipfile
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("archive_package",Path(__file__).with_name("archive-package.py"))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class Source16ArchiveTests(unittest.TestCase):
    def archive(self,path,version,marker=None,location="state/projects.json"):
        # These are ordinary-sized, fully listed ZIP entries with real hashes.
        # They prove rejection order only, not a valid sealed project or media.
        bodies={"snapshot.json":{"schema":"hv-state/"+str(version)},
            "state/projects.json":{"version":1,"projects":[{"id":"project"}],"reviewLinks":[],"takenDown":[],"takedownLog":[]},
            "queue/jobs.json":[],"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[]}
        if marker is not None:
            if isinstance(bodies[location],list): bodies[location].append({"abandoned":marker})
            else: bodies[location]["abandoned"]=marker
        data={name:json.dumps(body).encode("utf-8") for name,body in bodies.items()}
        entries=[{"path":name,"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()} for name,raw in data.items()]
        manifest={"schema":module.SCHEMA,"projectId":"project","files":entries,"totalBytes":sum(row["bytes"] for row in entries)}
        with zipfile.ZipFile(path,"w",compression=zipfile.ZIP_STORED) as archive:
            for name,raw in data.items(): archive.writestr(name,raw)
            archive.writestr("archive.json",json.dumps(manifest))

    def test_ordinary_zip_downgrades_refuse_before_any_extraction_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); source=root/"source.zip"; destination=root/"unpacked"
            for version in range(1,16):
                for marker in ({"schema":"hv-edit-library/2"},{"schema":"hv-edit-source/4"}):
                    for location in sorted(module.STATE_FILES):
                        with self.subTest(version=version,marker=marker["schema"],location=location):
                            self.archive(source,version,marker,location)
                            with patch.object(Path,"mkdir",side_effect=AssertionError("extraction attempted")) as mkdir,patch.object(module,"project_scope") as late,patch.object(module,"verify_current_screenplay") as ownership:
                                with self.assertRaisesRegex(ValueError,"schema 16 before extraction"): module.unpack(source,destination)
                                mkdir.assert_not_called(); late.assert_not_called(); ownership.assert_not_called()
                            self.assertEqual(sorted(path.name for path in root.iterdir()),["source.zip"])

    def test_state16_zip_requires_ownership_before_any_extraction_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); source=root/"source.zip"
            for marker in ({"schema":"hv-edit-library/2"},{"schema":"hv-edit-source/4"}):
                for location in sorted(module.STATE_FILES):
                    with self.subTest(marker=marker["schema"],location=location):
                        self.archive(source,16,marker,location)
                        domain=location in ("state/projects.json","queue/jobs.json")
                        with patch.object(Path,"mkdir",side_effect=AssertionError("extraction attempted")) as mkdir,patch.object(module,"project_scope") as late,patch.object(module,"verify_current_screenplay",side_effect=ValueError("unowned marker")) as ownership:
                            with self.assertRaisesRegex(ValueError,"unowned marker" if domain else "has no owner"): module.unpack(source,root/"unpacked")
                            if domain: self.assertEqual(ownership.call_args.args[-1],16)
                            else: ownership.assert_not_called()
                            mkdir.assert_not_called(); late.assert_not_called()
                        self.assertEqual(sorted(path.name for path in root.iterdir()),["source.zip"])

    def scope(self,root,project,schema):
        bodies={"snapshot.json":{"schema":schema},"state/projects.json":{"version":1,"projects":[project],"reviewLinks":[],"takenDown":[],"takedownLog":[]},
            "queue/jobs.json":[],"state/cost-ledger.json":{"events":[],"reservations":[]},"state/operator-review-queue.json":[]}
        for key,body in bodies.items():
            path=root/key; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(json.dumps(body))

    def mapping(self):
        original={"path":"project/bootstrap/output/source.mp4","bytes":7,"sha256":hashlib.sha256(b"source!").hexdigest()}
        bootstrap={"schema":"hv-edit-source/1","revision":"a"*64,"job":{"id":"bootstrap","projectId":"project","output":{"mp4Path":original["path"]}},"files":[original]}
        inner={**original,"path":"project/mixed/proof/originals/"+bootstrap["revision"]+"/"+original["path"]}
        film={"id":"mixed","projectId":"project","currentFilm":{"schema":"hv-current-film-job/3","origins":[],"library":{"origin":{"request":{"source":bootstrap}}}},
            "currentFilmProof":{"specification":{"frozenContext":{"project":{"source":bootstrap},"jobs":[]},"carriers":[{"receiptRevision":bootstrap["revision"],"copies":[{"original":original,"owned":inner}]}]}}}
        own={"path":"project/mixed/exports/film.mp4","bytes":4,"sha256":hashlib.sha256(b"film").hexdigest()}
        receipt={"schema":"hv-edit-source/4","revision":"b"*64,"job":film,"files":[inner,own]}
        copies=[{"original":file,"copy":{**file,"path":"project/carrier/output/sources/mixed/original/"+file["path"]}} for file in receipt["files"]]
        carrier=({"id":"carrier","projectId":"project"},{"receipt":receipt,"copies":copies},[item["copy"] for item in copies])
        return bootstrap,receipt,carrier

    def test_every_older_schema_refuses_new_markers_before_native_or_paths(self):
        for marker in ({"schema":"hv-edit-library/2"},{"schema":"hv-edit-source/4"}):
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)
                for version in range(1,16):
                    self.scope(root,{"id":"project","abandoned":[marker]},"hv-state/"+str(version))
                    with patch.object(module,"verify_current_screenplay") as ownership,patch.object(module,"verify_execution_media") as media:
                        with self.assertRaisesRegex(ValueError,"schema 16"): module.project_scope(root,"project")
                        ownership.assert_not_called(); media.assert_not_called()

    def test_schema16_requires_exact_ts_ownership_before_receipt_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); self.scope(root,{"id":"project","abandoned":[{"schema":"hv-edit-source/4"}]},"hv-state/16")
            with patch.object(module,"verify_current_screenplay",side_effect=ValueError("unowned marker")) as ownership,patch.object(module,"source16_records") as files,patch.object(module,"verify_execution_media") as media:
                with self.assertRaisesRegex(ValueError,"unowned marker"): module.project_scope(root,"project")
                self.assertEqual(ownership.call_args.args[-1],16); files.assert_not_called(); media.assert_not_called()

    def test_complete_parent_mapping_preserves_jobs_and_actual_outer_owner(self):
        bootstrap,receipt,carrier=self.mapping(); before=copy.deepcopy([bootstrap,receipt,carrier]); top=[carrier[0]]
        mapped=module.nested_source16_carriers([receipt,bootstrap],top,[carrier],"project")
        self.assertEqual(len(mapped),1); owner,retained,files=mapped[0]
        self.assertEqual(owner,carrier[0]); self.assertEqual(owner["id"],"carrier")
        self.assertEqual(retained["receipt"],bootstrap)
        self.assertEqual(retained["copies"][0]["original"],bootstrap["files"][0])
        self.assertEqual(files,[carrier[1]["copies"][0]["copy"]])
        self.assertEqual([bootstrap,receipt,carrier],before); self.assertEqual(top,[carrier[0]])
        self.assertFalse(any(job["id"] in ("bootstrap","mixed") for job in top))

    def test_nested_custody_requires_every_parent_role_and_exact_digest_tuple(self):
        bootstrap,receipt,carrier=self.mapping()
        for mutation in ("missing_parent","changed_digest","foreign_owner","missing_copy"):
            child,parent,held=copy.deepcopy((bootstrap,receipt,carrier))
            if mutation=="missing_parent":
                parent["files"].pop(0); held[1]["copies"].pop(0); held[2].pop(0)
            elif mutation=="changed_digest": held[1]["copies"][0]["copy"]["sha256"]="c"*64
            elif mutation=="foreign_owner": held[1]["copies"][0]["copy"]["path"]="project/foreign/film.mp4"
            else: held[1]["copies"].pop()
            # Sharing in this metadata fixture is intentional; all copies are in
            # one deepcopy so mutation describes one exact attempted tuple body.
            with self.assertRaises(ValueError): module.nested_source16_carriers([parent,child],[held[0]],[held],"project")

    def test_receipt_four_never_receives_large_preview_size_exception(self):
        _,receipt,_=self.mapping()
        with patch.object(module,"MAX_FILE_BYTES",8):
            self.assertEqual(module.source16_records(receipt,"project"),receipt["files"])
            for value in (9,True,0,-1,1.5):
                bad=copy.deepcopy(receipt); bad["files"][0]["bytes"]=value
                with self.assertRaisesRegex(ValueError,"metadata"): module.source16_records(bad,"project")
        repeated=copy.deepcopy(receipt); repeated["files"].append(copy.deepcopy(repeated["files"][0]))
        with self.assertRaisesRegex(ValueError,"repeated"): module.source16_records(repeated,"project")

    def test_generic_history_collection_keeps_unselected_sources_and_refuses_conflicts(self):
        child,parent,_=self.mapping()
        value={"legacyProposal":{"editorial":{"schema":"hv-edit-library/2","sources":[parent,child]}},"abandoned":[copy.deepcopy(parent)]}
        found,sources=module.editorial16_contexts(value,[])
        self.assertTrue(found); self.assertEqual({source["revision"] for source in sources},{parent["revision"],child["revision"]})
        value["abandoned"][0]["files"][0]["bytes"]+=1
        with self.assertRaisesRegex(ValueError,"conflict"): module.editorial16_contexts(value,[])
        self.assertEqual(module.editorial16_contexts({"schema":"hv-edit-source/4"},[],False),(True,[]))

    def test_fixed_receipt_bridge_transmits_order_label_and_language_and_cleans_owned_probe(self):
        _,receipt,_=self.mapping(); receipt.update(delivery={"segments":["project/mixed/hls/segment-002.ts","project/mixed/hls/segment-001.ts"]},facts={"label":"Original owner label"},language="fr")
        item={"receipt":receipt,"artifactRoot":"unchanged-owned-original-root"}; before=copy.deepcopy(item); scratches=[]
        def inspect(payload,code,schema,kind):
            self.assertEqual(payload["receipt"],receipt); self.assertEqual(payload["artifactRoot"],item["artifactRoot"])
            self.assertIn("verifyEditSourceReceiptArchive",code); self.assertNotIn("verifyCurrentFilmMedia",code); self.assertEqual(schema,16)
            scratch=Path(payload["probeScratch"]); self.assertTrue(scratch.is_dir()); self.assertEqual(list(scratch.iterdir()),[]); scratches.append(scratch)
        with patch.object(module,"verify_assembly_metadata",side_effect=inspect): module.verify_source16_media([item])
        self.assertEqual(item,before); self.assertTrue(all(not path.exists() for path in scratches))
        def fail(payload,*args):
            scratches.append(Path(payload["probeScratch"])); raise ValueError("native refusal")
        with patch.object(module,"verify_assembly_metadata",side_effect=fail):
            with self.assertRaisesRegex(ValueError,"native refusal"): module.verify_source16_media([item])
        self.assertTrue(all(not path.exists() for path in scratches))

    def test_checkpoint_and_output_dispatch_reproduce_conversion_and_conform(self):
        _,receipt,_=self.mapping(); result={"prepared":{"sources":[{"receipt":receipt}]}}
        output={"editorial":result}; job={"id":"carrier","editCheckpoint":copy.deepcopy(output),"output":output}
        assembly={"id":"assembly","assemblyCheckpoint":{"assembly":result}}
        with patch.object(module,"verify_assembly_metadata") as verify:
            module.verify_source16_conforms(Path("owned-root"),[job,assembly]); self.assertEqual(verify.call_count,2)
            for call in verify.call_args_list:
                payload,code,schema,_=call.args; self.assertEqual(schema,16)
                self.assertIn("verifyEditMedia",code); self.assertIn("verifyEditAssemblyMedia",code)
                self.assertEqual(payload["job"],job if payload["kind"]=="editorial" else assembly)
            legacy=copy.deepcopy(job); legacy["output"]["editorial"]["prepared"]["sources"][0]["receipt"]["schema"]="hv-edit-source/3"; legacy.pop("editCheckpoint")
            verify.reset_mock(); module.verify_source16_conforms(Path("owned-root"),[legacy]); verify.assert_not_called()

    def test_v2_source_bridge_and_direct_generation_origin_stay_strict(self):
        with patch.object(module,"verify_assembly_metadata") as verify:
            module.verify_current_source_media([{"job":{"id":"source"},"artifactRoot":"root"}]); payload,code,schema,_=verify.call_args.args
            self.assertEqual(schema,13); self.assertIn("verifyCurrentFilmMedia",code); self.assertNotIn("verifyEditSourceReceiptArchive",code)
        _,receipt,_=self.mapping(); job=copy.deepcopy(receipt["job"])
        job["currentFilm"]["origins"]=[{"id":receipt["revision"],"binding":{"source":receipt}}]
        job["currentFilmOrigins"]={"origins":[{"originId":receipt["revision"],"copies":[]}]}
        with self.assertRaisesRegex(ValueError,"exact owning source"): module.mixed_original_carriers([job],"project")

if __name__=="__main__": unittest.main()
