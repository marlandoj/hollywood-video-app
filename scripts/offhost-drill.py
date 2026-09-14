#!/usr/bin/env python3
"""Run the off-host transport end to end against a synthetic repository and record the lag.

Everything happens inside one mkdtemp: the fixture repository, the throwaway age identity, the
encrypted copy and the reconstructed tree. No database, bucket, staging repository, live backup
repository or operator identity is touched, and nothing is written outside that temporary root and
the two paths the caller names: --output for the evidence record, and --keep-extracted for the
reconstructed repository, which packages/storage/test/offhost-recovery.test.ts points at a
temporary directory so it can run verifyStorageBackup() against the tree after the drill exits.

What the figure is. `snapshotToCopyMs` is `copyDurableAt - snapshotAt`, where `snapshotAt` is the
manifest stamp this drill writes into the fixture at construction and `copyDurableAt` is the wall
clock instant at which the copy and its receipt have both been fsynced. On a real repository
`snapshotAt` is the PostgreSQL transaction_timestamp() of the exported repeatable-read snapshot
(packages/storage/src/backups.ts); here it is a fixture stamp, which `measuredOn` says in the
record. The drill therefore measures packaging correctness and a lower bound on the packaging
component of an off-host copy. It does not establish an off-host RPO, an independent durable
destination, or recovery from the loss of the host: it runs on one machine, against invented data,
with a key created and destroyed in the same process.
"""
import argparse,datetime,hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile,uuid
from pathlib import Path

if sys.version_info<(3,11):raise SystemExit('off-host drill requires Python 3.11 or newer for hashlib.file_digest')

SCRIPTS=Path(__file__).resolve().parent
CHECKOUT=SCRIPTS.parent
_spec=importlib.util.spec_from_file_location('offhost_transport',SCRIPTS/'offhost-backup.py')
transport=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(transport)
MAX_BYTES=64*1024**2
KEY_SHAPES=['v1/<projectId>/<jobId>/<sha256>/<name>','v1/<projectId>/reference-<uuid>/<sha256>/reference.png','archives/<a>/<b>/<sha256>.zip']

def stamp(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%S.')+f'{moment.microsecond//1000:03d}Z'
def now():return datetime.datetime.now(datetime.timezone.utc)
def lag_ms(snapshot_at,copy_durable_at):
    """Whole milliseconds between two millisecond stamps, by exact integer arithmetic.

    Both ends are stamped to the millisecond, so the figure must be the exact difference that
    Date.parse(copyDurableAt) - Date.parse(snapshotAt) yields in the test that pins criterion 8's
    identity. total_seconds() goes through a float: timedelta(milliseconds=1001).total_seconds()*1000
    is 1000.9999999999999, and int() would truncate that to 1000. Dividing timedeltas keeps it exact.
    """
    parse=lambda value:datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
    return (parse(copy_durable_at)-parse(snapshot_at))//datetime.timedelta(milliseconds=1)
def fsynced(path,data):
    descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'wb') as target:target.write(data);target.flush();os.fsync(target.fileno())
def build_repository(root):
    """Write a synthetic hv-backup/1 repository: dedup pool, an archive key, a reference key, decoys."""
    root.mkdir(mode=0o700);(root/'blobs').mkdir(mode=0o700)
    identity=stamp(now()).replace('-','').replace(':','').replace('.','')+'-'+str(uuid.uuid4())
    snapshot=root/'snapshots'/identity;snapshot.mkdir(mode=0o700,parents=True)
    (root/'repository.lock').touch(mode=0o600)
    def blob(data):
        checksum=hashlib.sha256(data).hexdigest();fsynced(root/'blobs'/checksum,data)
        return {'bytes':len(data),'sha256':checksum}
    media=blob(b'drill media bytes: one rendered shot, shared by two object keys\n')
    reference=blob(b'drill reference asset bytes: a character reference PNG payload\n')
    archive=blob(b'drill archive bytes: one delivered project archive\n')
    project='drillproject';job=str(uuid.uuid4())
    objects=[{'key':'v1/'+project+'/'+job+'/'+media['sha256']+'/'+name,**media} for name in ('shot-0001.mp4','shot-0001-proxy.mp4')]
    objects.append({'key':'v1/'+project+'/reference-'+str(uuid.uuid4())+'/'+reference['sha256']+'/reference.png',**reference})
    objects.append({'key':'archives/'+archive['sha256'][:2]+'/'+archive['sha256'][2:4]+'/'+archive['sha256']+'.zip',**archive})
    dump=b'drill database dump bytes: a pg_dump custom archive stands in here\n'
    fsynced(snapshot/'state.dump',dump)
    source={'cluster':'6928451037264519843','database':'hollywood_video_drill_fixture'}
    snapshot_at=now();completed_at=snapshot_at+datetime.timedelta(milliseconds=1)
    manifest={'schema':'hv-backup/1','id':identity,'source':source,'snapshotAt':stamp(snapshot_at),'completedAt':stamp(completed_at),
        'database':{'file':'state.dump','bytes':len(dump),'sha256':hashlib.sha256(dump).hexdigest()},'objects':objects,
        'summary':{'projects':2,'jobs':3,'costEvents':0,'recordedCostUsd':0}}
    encoded=transport.encoded(manifest);checksum=hashlib.sha256(encoded).hexdigest()
    fsynced(snapshot/'backup.json',encoded)
    fsynced(snapshot/'receipt.json',transport.encoded({'schema':'hv-backup-receipt/1','manifestSha256':checksum}))
    fsynced(root/'repository.json',transport.encoded({'schema':'hv-backup-repository/1','source':source}))
    fsynced(root/'latest.json',transport.encoded({'schema':'hv-backup-latest/1','id':identity,'snapshotAt':manifest['snapshotAt'],
        'completedAt':manifest['completedAt'],'manifestSha256':checksum}))
    # Decoys. The writer and the scheduler leave these beside a live repository; the transport builds
    # its file list from the manifest, so none of them may appear in the copy or the restored tree.
    fsynced(root/'prune-pending.json',transport.encoded({'schema':'hv-backup-prune/1','source':source,'snapshots':[]}))
    fsynced(root/'service-status.json',transport.encoded({'schema':'hv-backup-service/1','localRepositoryOnly':True}))
    fsynced(root/'blobs'/(media['sha256']+'.'+str(uuid.uuid4())+'.pending'),b'half-written blob that must never travel\n')
    (root/'trash').mkdir(mode=0o700);(root/'trash'/(identity+'-expired')).mkdir(mode=0o700)
    (root/'snapshots'/(identity+'.pending')).mkdir(mode=0o700)
    decoys=['prune-pending.json','service-status.json','trash/','blobs/<sha256>.<uuid>.pending','snapshots/<id>.pending']
    return {'root':root,'snapshot':identity,'manifest':manifest,'objects':len(objects),
        'blobs':len({item['sha256'] for item in objects}),'decoys':decoys}

def resolve_runtime(explicit):
    """Locate an installed, self-verifying age runtime; return None with a reason when there is none."""
    value=explicit or os.environ.get('HV_ENCRYPTION_RUNTIME') or ''
    if not value:return None,'no age runtime was supplied (--encryption-runtime or HV_ENCRYPTION_RUNTIME)'
    root=Path(value)
    if not root.is_absolute():return None,'the supplied age runtime path is not absolute'
    if not (root/'encryption.json').exists():return None,'the supplied age runtime has no verified encryption.json'
    try:binary=transport.encryption_binary(root.resolve())
    except Exception as error:return None,'the supplied age runtime failed its integrity recheck: '+str(error)
    keygen=binary.with_name(binary.name.replace('age-','age-keygen-',1))
    if not keygen.exists():return None,'the supplied age runtime has no age-keygen executable'
    return (binary,keygen),None

def run(command,**options):
    result=subprocess.run([str(item) for item in command],capture_output=True,timeout=300,**options)
    if result.returncode!=0:raise RuntimeError('drill step failed: '+' '.join(Path(str(item)).name for item in command[:2])+': '+result.stderr.decode('utf-8','replace')[-500:])
    return result

def package_plaintext(repository,output,lock_timeout):
    """Fallback for a host with no age runtime: the same bundle and receipt, unencrypted."""
    with transport.repository_lock(repository,lock_timeout):
        header=transport.snapshot_header(repository,MAX_BYTES)
        descriptor=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(descriptor,'wb') as target:
            transport.write_bundle(target,header,repository);target.flush();os.fsync(target.fileno())
    receipt={'schema':'hv-offhost-encryption/1','snapshot':header['snapshot'],'snapshotAt':header['snapshotAt'],'source':header['source'],
        'summary':header['summary'],'files':len(header['files']),'payloadBytes':sum(item['bytes'] for item in header['files']),
        'headerSha256':hashlib.sha256(transport.encoded(header)).hexdigest(),'manifestSha256':header['manifestSha256'],
        'ciphertextSha256':transport.digest(output),'ciphertextBytes':output.stat().st_size,'file':output.name,'recipient':None}
    fsynced(output.with_name(output.name+'.receipt.json'),transport.encoded(receipt)+b'\n')
    return receipt

def drill(base,explicit_runtime,lock_timeout,keep_extracted=None):
    fixture=build_repository(base/'repository');repository=fixture['root']
    source_header=transport.snapshot_header(repository,MAX_BYTES)
    runtime,reason=resolve_runtime(explicit_runtime)
    copy=base/'backup.age';plaintext=base/'bundle.bin'
    negatives={'wrongIdentityRefused':None,'bitFlipRefused':False,'existingDirectoryRefused':False}
    if runtime:
        binary,keygen=runtime;key=base/'identity.txt'
        run([keygen,'-o',key]);key.chmod(0o600)
        recipient=run([keygen,'-y',key]).stdout.decode().strip()
        receipt=json.loads(run([sys.executable,SCRIPTS/'offhost-backup.py','encrypt','--repository',repository,'--output',copy,
            '--recipient',recipient,'--encryption-runtime',binary.parent.parent,'--max-bytes',MAX_BYTES,'--lock-timeout',lock_timeout]).stdout)
        copy_durable_at=now()
        with plaintext.open('xb') as target:
            decrypt=subprocess.run([str(binary),'--decrypt','-i',str(key),str(copy)],stdout=target,stderr=subprocess.PIPE,timeout=300)
        if decrypt.returncode!=0:raise RuntimeError('drill decryption failed: '+decrypt.stderr.decode('utf-8','replace')[-500:])
        other=base/'other-identity.txt';run([keygen,'-o',other])
        negatives['wrongIdentityRefused']=subprocess.run([str(binary),'--decrypt','-i',str(other),str(copy)],capture_output=True,timeout=300).returncode!=0
        damaged=base/'damaged.age';data=copy.read_bytes();damaged.write_bytes(data[:-1]+bytes([data[-1]^1]))
        negatives['bitFlipRefused']=subprocess.run([str(binary),'--decrypt','-i',str(key),str(damaged)],capture_output=True,timeout=300).returncode!=0
        encryption={'exercised':True,'tool':'age','version':'1.3.2','identity':'throwaway, generated and destroyed in-process','recipientCommitted':False}
        bit_flip_layer='age ciphertext authentication'
    else:
        receipt=package_plaintext(repository,plaintext,lock_timeout);copy_durable_at=now()
        damaged=base/'damaged.bin';data=plaintext.read_bytes();damaged.write_bytes(data[:-1]+bytes([data[-1]^1]))
        with damaged.open('rb') as stream:
            try:transport.inspect_stream(stream,MAX_BYTES)
            except RuntimeError:negatives['bitFlipRefused']=True
        encryption={'exercised':False,'reason':reason,'tool':'age','identity':'throwaway, generated and destroyed in-process','recipientCommitted':False}
        bit_flip_layer='HV-OFFHOST-BUNDLE/1 payload checksum'
    restored=keep_extracted or base/'restored'
    verification=json.loads(run([sys.executable,SCRIPTS/'offhost-backup.py','inspect','--input',plaintext,'--extract',restored,'--max-bytes',MAX_BYTES]).stdout)
    second=subprocess.run([sys.executable,str(SCRIPTS/'offhost-backup.py'),'inspect','--input',str(plaintext),'--extract',str(restored),
        '--max-bytes',str(MAX_BYTES)],capture_output=True,timeout=300)
    negatives['existingDirectoryRefused']=second.returncode!=0 and b'new resolved' in second.stderr
    restored_header=transport.snapshot_header(restored,MAX_BYTES)
    if restored_header!=source_header:raise RuntimeError('reconstructed repository header differs from the source header')
    blobs=sorted((restored/'blobs').iterdir())
    for blob in blobs:
        if transport.digest(blob)!=blob.name:raise RuntimeError('reconstructed blob does not match its content address')
    if {item.name for item in restored.iterdir()}!={'blobs','snapshots','repository.json','latest.json','repository.lock'}:
        raise RuntimeError('reconstructed repository carries files the manifest never named')
    if shutil.which('bun'):
        checked=subprocess.run(['bun','scripts/storage-backup.ts','--verify','--repository',str(restored)],cwd=str(CHECKOUT),capture_output=True,timeout=300)
        # Reconstruction is the point of the drill: a tree main's own verifier rejects is a failed run,
        # not a recorded observation. Only an absent bun degrades to a skip.
        if checked.returncode!=0 or b'"verified":true' not in checked.stdout:
            raise RuntimeError('verifyStorageBackup rejected the reconstructed repository: '+checked.stderr.decode('utf-8','replace')[-300:])
        verified='passed'
    else:verified='skipped (no bun on PATH)'
    snapshot_at=source_header['snapshotAt'];durable=stamp(copy_durable_at)
    lag=lag_ms(snapshot_at,durable)
    return {'schema':'hv-offhost-drill/1','recordedAt':stamp(now()),
        'transport':{'schema':'hv-offhost-bundle/1','files':verification['files'],'payloadBytes':verification['payloadBytes'],
            'ciphertextBytes':receipt['ciphertextBytes'],'headerSha256':verification['headerSha256'],'manifestSha256':verification['manifestSha256']},
        'repository':{'objects':fixture['objects'],'blobs':fixture['blobs'],'deduplicatedKeys':fixture['objects']-fixture['blobs'],
            'keyShapes':KEY_SHAPES,'ignoredBookkeeping':fixture['decoys']},
        'encryption':encryption,
        'reconstruction':{'headerIdentical':True,'blobsReVerified':len(blobs),'verifyStorageBackup':verified},
        'negatives':{**negatives,'bitFlipRefusedBy':bit_flip_layer},
        'rpo':{'definition':'copyDurableAt - snapshotAt, where snapshotAt is the backup manifest stamp and copyDurableAt is the instant the copy and its receipt were both fsynced',
            'snapshotAt':snapshot_at,'copyDurableAt':durable,'snapshotToCopyMs':lag,'encrypted':encryption['exercised'],
            'measuredOn':'a synthetic fixture repository in a temporary directory on one machine; snapshotAt is the stamp this drill wrote into the fixture manifest at construction, not a PostgreSQL transaction_timestamp() read from a live database, so this figure is a packaging measurement and not a measurement of any database'},
        'operatorIdentityUsed':False,'provesOffHostRpo':False,'provesHostLossRecovery':False,
        'independentDestination':'none (same filesystem, temp directory)','continuousReplication':False,
        'restoredIntoLiveDatabase':False,'newProviderSpendUsd':0}

def main():
    parser=argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--output',type=Path,help='write the drill record here, atomically, in addition to stdout')
    parser.add_argument('--encryption-runtime',type=Path,help='an installed age runtime root; falls back to HV_ENCRYPTION_RUNTIME')
    parser.add_argument('--lock-timeout',type=int,default=transport.DEFAULT_LOCK_TIMEOUT)
    parser.add_argument('--keep-extracted',type=Path,help='reconstruct into this new absolute directory instead of the temporary root, so a caller can verify the tree after the drill exits')
    args=parser.parse_args()
    keep=args.keep_extracted
    if keep is not None:
        # Absolute as given: resolve() would manufacture absoluteness from a relative argument and
        # could place a reconstructed tree inside the checkout.
        if not keep.is_absolute():raise RuntimeError('--keep-extracted must be an absolute path, not one resolved against the working directory')
        keep=keep.resolve()
        if keep.exists() or keep.is_symlink():raise RuntimeError('--keep-extracted must name a new directory that does not exist yet')
    with tempfile.TemporaryDirectory(prefix='hv-offhost-drill-') as temporary:
        base=Path(temporary).resolve();os.chmod(base,0o700)
        record=drill(base,args.encryption_runtime,args.lock_timeout,keep)
    data=json.dumps(record,indent=2,sort_keys=True)+'\n'
    if args.output:
        output=args.output.resolve();pending=output.with_name(output.name+'.'+uuid.uuid4().hex+'.pending')
        try:
            descriptor=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(descriptor,'w') as target:target.write(data);target.flush();os.fsync(target.fileno())
            pending.chmod(0o644);os.replace(pending,output)
        finally:pending.unlink(missing_ok=True)
    print(data,end='')
if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'failed':True,'category':type(error).__name__,'reason':str(error) if isinstance(error,RuntimeError) else 'off-host drill failed'}),file=sys.stderr)
        raise SystemExit(1)
