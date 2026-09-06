#!/usr/bin/env python3
"""Encrypt one complete backup, or verify/extract its decrypted byte stream.

The age identity stays on the recovery host. This tool never loads database,
object-store, provider, or project signing credentials.
"""
import argparse,contextlib,datetime,hashlib,json,math,os,re,stat,struct,subprocess,sys,threading,time
from pathlib import Path

MAGIC=b'HV-OFFHOST-BUNDLE/1\n'
MAX_HEADER=16*1024**2
MAX_FILES=100_000
DEFAULT_MAX_BYTES=4*1024**3
SHA=re.compile(r'[a-f0-9]{64}')
ID=re.compile(r'[A-Za-z0-9_-]{1,128}')

def require(condition,message):
    if not condition:raise RuntimeError(message)
def regular(path):
    metadata=path.lstat();require(stat.S_ISREG(metadata.st_mode) and not path.is_symlink(),'backup transport file is not regular');return metadata
def digest(path):
    regular(path)
    with path.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()
def unique_object(pairs):
    result={}
    for key,value in pairs:
        require(key not in result,'duplicate transport metadata field');result[key]=value
    return result
def decode(data):return json.loads(data,object_pairs_hook=unique_object)
def bounded_json(path,limit):
    require(regular(path).st_size<=limit,'backup transport metadata exceeds limit')
    with path.open('rb') as source:data=source.read(limit+1)
    require(len(data)<=limit,'backup transport metadata exceeds limit');return decode(data)
def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def integer(value):return type(value) is int and value>=0
def timestamp(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z',value):return False
    try:datetime.datetime.fromisoformat(value.replace('Z','+00:00'));return True
    except ValueError:return False
def validate_header(value,max_bytes):
    require(isinstance(value,dict) and value.get('schema')=='hv-offhost-bundle/1','unknown backup transport schema')
    identity=value.get('snapshot');require(isinstance(identity,str) and ID.fullmatch(identity),'invalid transport snapshot identity')
    require(timestamp(value.get('snapshotAt')) and timestamp(value.get('completedAt')) and value['completedAt']>=value['snapshotAt'],'invalid transport timestamps')
    source=value.get('source');summary=value.get('summary')
    require(isinstance(source,dict) and isinstance(source.get('cluster'),str) and re.fullmatch(r'\d{1,32}',source['cluster']) and isinstance(source.get('database'),str) and re.fullmatch(r'[a-z][a-z0-9_]{0,62}',source['database']),'invalid transport source')
    require(isinstance(summary,dict) and all(integer(summary.get(name)) for name in ('projects','jobs','costEvents')) and type(summary.get('recordedCostUsd')) in (int,float) and math.isfinite(summary['recordedCostUsd']) and summary['recordedCostUsd']>=0,'invalid transport summary')
    require(isinstance(value.get('manifestSha256'),str) and SHA.fullmatch(value['manifestSha256']),'invalid manifest digest')
    files=value.get('files');require(isinstance(files,list) and 5<=len(files)<=MAX_FILES,'invalid transport file count')
    prefix=['repository.json','latest.json',*[f'snapshots/{identity}/{name}' for name in ('backup.json','receipt.json','state.dump')]]
    require([item.get('path') for item in files[:5] if isinstance(item,dict)]==prefix,'invalid transport metadata layout')
    paths=set();total=0
    for index,item in enumerate(files):
        require(isinstance(item,dict) and set(item)=={'path','bytes','sha256'},'invalid transport file record')
        path=item['path'];require(isinstance(path,str) and (path in prefix or re.fullmatch(r'blobs/[a-f0-9]{64}',path)),'unsafe transport file path')
        require(path not in paths,'duplicate transport file path');paths.add(path)
        require(integer(item['bytes']) and isinstance(item['sha256'],str) and SHA.fullmatch(item['sha256']),'invalid transport file size or digest')
        if index<4:require(item['bytes']<=MAX_HEADER,'transport metadata file exceeds limit')
        if path.startswith('blobs/'):require(path[6:]==item['sha256'],'transport blob is not content-addressed')
        total+=item['bytes'];require(total<=max_bytes,'backup transport exceeds configured byte limit')
    require(files[2]['sha256']==value['manifestSha256'],'transport manifest digest differs from index')
    return total

def validate_metadata(header,metadata):
    identity=header['snapshot'];manifest=metadata[f'snapshots/{identity}/backup.json'];receipt=metadata[f'snapshots/{identity}/receipt.json']
    marker=metadata['repository.json'];latest=metadata['latest.json']
    require(marker.get('schema')=='hv-backup-repository/1' and marker.get('source')==header['source'],'transport repository identity mismatch')
    require(latest.get('schema')=='hv-backup-latest/1' and latest.get('id')==identity and latest.get('manifestSha256')==header['manifestSha256'],'transport latest pointer mismatch')
    require(receipt.get('schema')=='hv-backup-receipt/1' and receipt.get('manifestSha256')==header['manifestSha256'],'transport receipt mismatch')
    require(manifest.get('schema')=='hv-backup/1' and manifest.get('id')==identity and all(manifest.get(key)==header[key] for key in ('source','summary','snapshotAt','completedAt')),'transport manifest identity mismatch')
    database=manifest.get('database',{});record=header['files'][4]
    require(database=={'file':'state.dump','bytes':record['bytes'],'sha256':record['sha256']},'transport database index mismatch')
    objects=manifest.get('objects');require(isinstance(objects,list) and len(objects)<=MAX_FILES,'invalid transport object index')
    blobs={};keys=set()
    for item in objects:
        require(isinstance(item,dict) and isinstance(item.get('sha256'),str) and SHA.fullmatch(item['sha256']) and integer(item.get('bytes')),'invalid object transport record')
        key=item.get('key');require(isinstance(key,str) and len(key)<=1024 and re.fullmatch(r'[A-Za-z0-9_./-]+',key) and all(part not in ('','.','..') for part in key.split('/')),'invalid object storage key')
        parts=key.split('/');require((len(parts)==5 and parts[0]=='v1' and parts[3]==item['sha256']) or (len(parts)==4 and parts[0]=='archives' and parts[3]==item['sha256']+'.zip'),'object key is not content-addressed')
        require(key not in keys,'duplicate object storage key');keys.add(key)
        require(item['sha256'] not in blobs or blobs[item['sha256']]==item['bytes'],'conflicting object lengths');blobs[item['sha256']]=item['bytes']
    require({item['path'][6:]:item['bytes'] for item in header['files'][5:]}==blobs,'transport does not contain the complete media set')

@contextlib.contextmanager
def repository_lock(root,timeout=30):
    import fcntl
    path=root/'repository.lock';regular(path)
    descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        deadline=time.monotonic()+timeout
        while True:
            try:fcntl.flock(descriptor,fcntl.LOCK_SH|fcntl.LOCK_NB);break
            except BlockingIOError:
                require(time.monotonic()<deadline,'backup repository is locked by maintenance');time.sleep(.05)
        yield
    finally:os.close(descriptor)

def snapshot_header(root,max_bytes):
    require(root.is_absolute() and root.resolve()==root and root.is_dir(),'choose a resolved backup repository')
    latest=bounded_json(root/'latest.json',4096);identity=latest.get('id')
    require(isinstance(identity,str) and ID.fullmatch(identity),'invalid latest snapshot')
    for folder in (root/'snapshots',root/'snapshots'/identity,root/'blobs'):
        require(not folder.is_symlink() and folder.is_dir(),'unsafe backup transport directory')
    manifest=bounded_json(root/'snapshots'/identity/'backup.json',MAX_HEADER)
    paths=['repository.json','latest.json',*[f'snapshots/{identity}/{name}' for name in ('backup.json','receipt.json','state.dump')]]
    require(isinstance(manifest.get('objects'),list) and len(manifest['objects'])<=MAX_FILES,'invalid backup object count')
    hashes=set()
    for item in manifest['objects']:
        require(isinstance(item,dict) and isinstance(item.get('sha256'),str) and SHA.fullmatch(item['sha256']),'invalid backup content address');hashes.add(item['sha256'])
    paths.extend('blobs/'+value for value in sorted(hashes))
    total=0;files=[]
    for name in paths:
        path=root/name;size=regular(path).st_size;total+=size
        require(total<=max_bytes,'backup transport exceeds configured byte limit')
        files.append({'path':name,'bytes':size,'sha256':digest(path)})
    header={'schema':'hv-offhost-bundle/1','snapshot':identity,'source':manifest.get('source'),'snapshotAt':manifest.get('snapshotAt'),
        'completedAt':manifest.get('completedAt'),'summary':manifest.get('summary'),'manifestSha256':files[2]['sha256'],'files':files}
    validate_header(header,max_bytes);validate_metadata(header,{name:bounded_json(root/name,MAX_HEADER) for name in paths[:4]})
    return header

def write_bundle(output,header,root):
    data=encoded(header);require(len(data)<=MAX_HEADER,'backup transport header exceeds limit')
    output.write(MAGIC+struct.pack('>I',len(data))+data)
    for item in header['files']:
        path=root/item['path'];regular(path);checksum=hashlib.sha256();remaining=item['bytes']
        descriptor=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
        with os.fdopen(descriptor,'rb') as source:
            require(stat.S_ISREG(os.fstat(source.fileno()).st_mode),'transport source is not regular')
            while remaining:
                chunk=source.read(min(1024**2,remaining));require(bool(chunk),'transport source was truncated')
                output.write(chunk);checksum.update(chunk);remaining-=len(chunk)
            require(not source.read(1) and checksum.hexdigest()==item['sha256'],'transport source changed during encryption')

def exact(source,count):
    chunks=[];remaining=count
    while remaining:
        chunk=source.read(min(1024**2,remaining));require(bool(chunk),'backup transport stream was truncated');chunks.append(chunk);remaining-=len(chunk)
    return b''.join(chunks)

def inspect_stream(source,max_bytes,destination=None):
    require(exact(source,len(MAGIC))==MAGIC,'unknown backup transport stream')
    size=struct.unpack('>I',exact(source,4))[0];require(0<size<=MAX_HEADER,'backup transport header exceeds limit')
    raw=exact(source,size);header=decode(raw);total=validate_header(header,max_bytes)
    if destination is not None:
        require(destination.is_absolute() and not destination.is_symlink() and not destination.exists() and destination.parent.resolve()==destination.parent,'choose a new resolved extraction directory')
        destination.mkdir(mode=0o700)
        for name in ('blobs','snapshots'):(destination/name).mkdir(mode=0o700)
    metadata={}
    for index,item in enumerate(header['files']):
        checksum=hashlib.sha256();remaining=item['bytes'];parts=[];output=None
        if destination is not None:
            path=destination/item['path'];path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0),0o600);output=os.fdopen(descriptor,'wb')
        try:
            while remaining:
                chunk=exact(source,min(1024**2,remaining));checksum.update(chunk);remaining-=len(chunk)
                if output:output.write(chunk)
                if index<4:parts.append(chunk)
            require(checksum.hexdigest()==item['sha256'],'backup transport payload checksum mismatch')
            if output:output.flush();os.fsync(output.fileno())
        finally:
            if output:output.close()
        if index<4:metadata[item['path']]=decode(b''.join(parts))
    require(not source.read(1),'backup transport stream has trailing data');validate_metadata(header,metadata)
    if destination is not None:
        (destination/'repository.lock').touch(mode=0o600,exist_ok=False)
    return {'schema':'hv-offhost-verification/1','snapshot':header['snapshot'],'snapshotAt':header['snapshotAt'],'source':header['source'],
        'summary':header['summary'],'files':len(header['files']),'payloadBytes':total,'headerSha256':hashlib.sha256(raw).hexdigest(),
        'manifestSha256':header['manifestSha256'],'extracted':destination is not None}

def encryption_binary(root):
    value=bounded_json(root/'encryption.json',16384)
    require(value.get('schema')=='hv-backup-encryption/1' and value.get('version')=='1.3.2','invalid encryption runtime manifest')
    record=value['binaries']['age'];path=Path(record['path'])
    require(path.parent==root/'bin' and path.name in ('age-1.3.2','age-1.3.2.exe') and digest(path)==record['sha256'],'encryption binary integrity failed')
    return path

def encrypt(root,output,recipient,encryption,max_bytes):
    require(os.name=='posix','backup encryption uses the Linux repository lock; decrypt and inspect on the recovery host')
    require(isinstance(recipient,str) and re.fullmatch(r'age1[ac-hj-np-z02-9]{58}',recipient),'use a native age public recipient')
    require(output.is_absolute() and output.parent.resolve()==output.parent and not output.exists() and not output.is_symlink(),'choose a new resolved encrypted output file')
    binary=encryption_binary(encryption);receipt=output.with_name(output.name+'.receipt.json')
    require(not receipt.exists() and not receipt.is_symlink(),'encrypted output receipt already exists')
    with repository_lock(root):
        header=snapshot_header(root,max_bytes)
        descriptor=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(descriptor,'wb') as target:
            environment={key:os.environ[key] for key in ('PATH','SYSTEMROOT') if key in os.environ}
            child=subprocess.Popen([str(binary),'--encrypt','--recipient',recipient],env=environment,stdin=subprocess.PIPE,stdout=target,stderr=subprocess.DEVNULL)
            timer=threading.Timer(300,child.kill);timer.start()
            try:
                write_bundle(child.stdin,header,root);child.stdin.close()
                require(child.wait(timeout=10)==0,'backup encryption failed')
                target.flush();os.fsync(target.fileno())
            finally:
                timer.cancel()
                if child.poll() is None:child.kill();child.wait()
    result={'schema':'hv-offhost-encryption/1','snapshot':header['snapshot'],'snapshotAt':header['snapshotAt'],'source':header['source'],
        'summary':header['summary'],'files':len(header['files']),'payloadBytes':sum(item['bytes'] for item in header['files']),
        'headerSha256':hashlib.sha256(encoded(header)).hexdigest(),'manifestSha256':header['manifestSha256'],
        'ciphertextSha256':digest(output),'ciphertextBytes':output.stat().st_size,'file':output.name,'recipient':recipient}
    descriptor=os.open(receipt,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(descriptor,'wb') as target:target.write(encoded(result)+b'\n');target.flush();os.fsync(target.fileno())
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__);mode=parser.add_subparsers(dest='mode',required=True)
    pack=mode.add_parser('encrypt');pack.add_argument('--repository',type=Path,required=True);pack.add_argument('--output',type=Path,required=True)
    pack.add_argument('--recipient',required=True);pack.add_argument('--encryption-runtime',type=Path,required=True)
    read=mode.add_parser('inspect');read.add_argument('--input',type=Path);read.add_argument('--extract',type=Path)
    for command in (pack,read):command.add_argument('--max-bytes',type=int,default=DEFAULT_MAX_BYTES)
    args=parser.parse_args();require(0<args.max_bytes<=72*1024**3,'invalid transport byte limit')
    if args.mode=='encrypt':result=encrypt(args.repository,args.output,args.recipient,args.encryption_runtime,args.max_bytes)
    elif args.input:
        regular(args.input)
        with args.input.open('rb') as source:result=inspect_stream(source,args.max_bytes,args.extract)
    else:result=inspect_stream(sys.stdin.buffer,args.max_bytes,args.extract)
    print(json.dumps(result))
if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'failed':True,'category':type(error).__name__,'reason':str(error) if isinstance(error,RuntimeError) else 'backup transport operation failed'}),file=sys.stderr)
        raise SystemExit(1)
