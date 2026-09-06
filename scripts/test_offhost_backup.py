import copy,hashlib,importlib.util,io,json,os,struct,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('transport',Path(__file__).with_name('offhost-backup.py'))
transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)

class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='hv-offhost-');self.root=Path(self.temporary.name).resolve()
        self.repository=self.root/'backup';self.repository.mkdir();(self.repository/'blobs').mkdir()
        self.identity='20260906T000000000Z-fixture';snapshot=self.repository/'snapshots'/self.identity;snapshot.mkdir(parents=True)
        (self.repository/'repository.lock').touch()
        def put(path,data):path.write_bytes(data);return {'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
        media=b'fixture media bytes';media_record=put(self.repository/'blobs'/hashlib.sha256(media).hexdigest(),media)
        database=put(snapshot/'state.dump',b'fixture database bytes')
        source={'cluster':'123456','database':'hollywood_video_staging_fixture'}
        manifest={'schema':'hv-backup/1','id':self.identity,'source':source,'snapshotAt':'2026-09-06T00:00:00.000Z','completedAt':'2026-09-06T00:00:01.000Z',
            'database':{'file':'state.dump',**database},'summary':{'projects':1,'jobs':2,'costEvents':3,'recordedCostUsd':.144},
            'objects':[{'key':'v1/project/job/'+media_record['sha256']+'/'+name,**media_record} for name in ('one.mp4','two.mp4')]}
        manifest_hash=put(snapshot/'backup.json',transport.encoded(manifest))['sha256']
        (snapshot/'receipt.json').write_bytes(transport.encoded({'schema':'hv-backup-receipt/1','manifestSha256':manifest_hash}))
        (self.repository/'repository.json').write_bytes(transport.encoded({'schema':'hv-backup-repository/1','source':source}))
        (self.repository/'latest.json').write_bytes(transport.encoded({'schema':'hv-backup-latest/1','id':self.identity,'snapshotAt':manifest['snapshotAt'],'completedAt':manifest['completedAt'],'manifestSha256':manifest_hash}))
        self.header=transport.snapshot_header(self.repository,100000)
    def tearDown(self):self.temporary.cleanup()
    def bundle(self,header=None):
        output=io.BytesIO();transport.write_bundle(output,header or self.header,self.repository);return output.getvalue()
    def test_complete_deduplicated_copy_roundtrips_without_database_credentials(self):
        payload=self.bundle();destination=self.root/'restored'
        result=transport.inspect_stream(io.BytesIO(payload),100000,destination)
        self.assertEqual(result['files'],6);self.assertEqual(result['summary'],self.header['summary'])
        self.assertEqual(transport.snapshot_header(destination,100000),self.header)
        self.assertEqual(len(list((destination/'blobs').iterdir())),1)
        with self.assertRaisesRegex(RuntimeError,'new resolved'):transport.inspect_stream(io.BytesIO(payload),100000,destination)
    def test_corruption_truncation_and_trailing_bytes_do_not_verify(self):
        payload=self.bundle()
        for altered in (payload[:-1],payload[:-1]+bytes([payload[-1]^1]),payload+b'unexpected'):
            with self.assertRaises(RuntimeError):transport.inspect_stream(io.BytesIO(altered),100000)
    def test_traversal_duplicate_paths_and_unbounded_headers_are_rejected_before_extraction(self):
        for path in ('../escape','/absolute','C:/escape','blobs/../escape',self.header['files'][0]['path']):
            header=copy.deepcopy(self.header);header['files'][-1]['path']=path;data=transport.encoded(header)
            payload=transport.MAGIC+struct.pack('>I',len(data))+data;destination=self.root/'refused'
            with self.assertRaises(RuntimeError):transport.inspect_stream(io.BytesIO(payload),100000,destination)
            self.assertFalse(destination.exists())
        with self.assertRaisesRegex(RuntimeError,'header exceeds'):transport.inspect_stream(io.BytesIO(transport.MAGIC+struct.pack('>I',transport.MAX_HEADER+1)),100000)
    def test_byte_limit_and_conflicting_source_are_refused(self):
        with self.assertRaisesRegex(RuntimeError,'byte limit'):transport.inspect_stream(io.BytesIO(self.bundle()),10)
        header=copy.deepcopy(self.header);header['source']['database']='another_database'
        with self.assertRaisesRegex(RuntimeError,'repository identity'):transport.inspect_stream(io.BytesIO(self.bundle(header)),100000)
    def test_missing_media_and_changed_sources_are_refused(self):
        header=copy.deepcopy(self.header);header['files']=header['files'][:-1]
        with self.assertRaisesRegex(RuntimeError,'complete media'):transport.inspect_stream(io.BytesIO(self.bundle(header)),100000)
        blob=self.repository/self.header['files'][-1]['path'];blob.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError,'truncated|changed'):self.bundle()
    @unittest.skipUnless(os.name=='posix','POSIX symlinks checked on Linux')
    def test_symlinked_media_or_metadata_is_never_packed(self):
        blob=self.repository/self.header['files'][-1]['path'];original=blob.read_bytes();blob.unlink()
        target=self.root/'unrelated';target.write_bytes(original);blob.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError,'not regular'):transport.snapshot_header(self.repository,100000)
    def test_duplicate_json_fields_are_refused(self):
        data=b'{"schema":"ignored","schema":"hv-offhost-bundle/1"}'
        with self.assertRaisesRegex(RuntimeError,'duplicate'):transport.inspect_stream(io.BytesIO(transport.MAGIC+struct.pack('>I',len(data))+data),100000)
    @unittest.skipUnless(os.name=='posix' and os.environ.get('HV_ENCRYPTION_TEST_RUNTIME'),'native age roundtrip runs on Linux CI')
    def test_native_age_roundtrip_wrong_key_and_failed_encryption(self):
        runtime=Path(os.environ['HV_ENCRYPTION_TEST_RUNTIME']);binary=transport.encryption_binary(runtime)
        keygen=runtime/'bin/age-keygen-1.3.2';key=self.root/'identity.txt'
        subprocess.run([str(keygen),'-o',str(key)],check=True,capture_output=True)
        recipient=subprocess.check_output([str(keygen),'-y',str(key)],text=True).strip()
        cipher=self.root/'backup.age';receipt=transport.encrypt(self.repository,cipher,recipient,runtime,100000)
        result=subprocess.run([str(binary),'--decrypt','-i',str(key),str(cipher)],check=True,capture_output=True)
        verified=transport.inspect_stream(io.BytesIO(result.stdout),100000)
        self.assertEqual(verified['headerSha256'],receipt['headerSha256']);self.assertEqual(transport.digest(cipher),receipt['ciphertextSha256'])
        other=self.root/'other.txt';subprocess.run([str(keygen),'-o',str(other)],check=True,capture_output=True)
        self.assertNotEqual(subprocess.run([str(binary),'--decrypt','-i',str(other),str(cipher)],capture_output=True).returncode,0)
        damaged=self.root/'damaged.age';data=cipher.read_bytes();damaged.write_bytes(data[:-1]+bytes([data[-1]^1]))
        self.assertNotEqual(subprocess.run([str(binary),'--decrypt','-i',str(key),str(damaged)],capture_output=True).returncode,0)
        with self.assertRaisesRegex(RuntimeError,'new resolved'):transport.encrypt(self.repository,cipher,recipient,runtime,100000)
        failed=self.root/'failed.age'
        with patch.object(transport,'encryption_binary',return_value=Path('/bin/false')):
            with self.assertRaises((RuntimeError,BrokenPipeError)):transport.encrypt(self.repository,failed,recipient,runtime,100000)
        self.assertFalse(failed.with_name(failed.name+'.receipt.json').exists())

if __name__=='__main__':unittest.main()
