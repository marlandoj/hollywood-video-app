#!/usr/bin/env python3
"""Install checksum-pinned age tools for private off-host backup transport."""
import argparse,hashlib,json,os,platform,stat,tarfile,urllib.request,uuid,zipfile
from pathlib import Path

VERSION='1.3.2'
RELEASES={
 'Linux':{'file':'age-v1.3.2-linux-amd64.tar.gz','bytes':19405817,'sha256':'cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10'},
 'Windows':{'file':'age-v1.3.2-windows-amd64.zip','bytes':20250704,'sha256':'f48d8f8f9ebe903ab5027ed067652f2cc1db94bc206976430133b905dcd8e8c7'},
}
def regular(path):
    if path.is_symlink() or not path.is_file():raise RuntimeError('encryption runtime file is not regular')
def digest(path):
    regular(path)
    with path.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()
def directory(path):
    if path.is_symlink() or (path.exists() and not path.is_dir()):raise RuntimeError('unsafe encryption runtime directory')
    path.mkdir(parents=True,exist_ok=True,mode=0o755)
def install(root,system):
    release=RELEASES[system];extension='.exe' if system=='Windows' else ''
    for path in (root,root/'downloads',root/'bin'):directory(path)
    archive=root/'downloads'/release['file']
    if not archive.exists():
        pending=archive.with_name(archive.name+'.'+uuid.uuid4().hex+'.pending')
        try:
            with urllib.request.urlopen('https://github.com/FiloSottile/age/releases/download/v'+VERSION+'/'+release['file'],timeout=45) as response,pending.open('xb') as output:
                size=0
                while chunk:=response.read(1024**2):
                    size+=len(chunk)
                    if size>release['bytes']:raise RuntimeError('encryption release exceeded pinned size')
                    output.write(chunk)
                output.flush();os.fsync(output.fileno())
            if size!=release['bytes'] or digest(pending)!=release['sha256']:raise RuntimeError('encryption release checksum mismatch')
            os.replace(pending,archive)
        finally:pending.unlink(missing_ok=True)
    if archive.stat().st_size!=release['bytes'] or digest(archive)!=release['sha256']:raise RuntimeError('cached encryption release checksum mismatch')
    result={}
    package=zipfile.ZipFile(archive) if system=='Windows' else tarfile.open(archive,'r:gz')
    with package:
        for name in ('age','age-keygen'):
            member_name='age/'+name+extension
            members=[member for member in (package.infolist() if system=='Windows' else package.getmembers()) if (member.filename if system=='Windows' else member.name)==member_name]
            if len(members)!=1:raise RuntimeError('encryption release executable is missing or duplicated')
            member=members[0];size=member.file_size if system=='Windows' else member.size
            if not 0<size<100*1024**2 or (system=='Windows' and (member.is_dir() or stat.S_ISLNK(member.external_attr>>16))) or (system!='Windows' and not member.isfile()):raise RuntimeError('encryption executable is not a bounded regular file')
            target=root/'bin'/(name+'-'+VERSION+extension);pending=target.with_name(target.name+'.'+uuid.uuid4().hex+'.pending')
            try:
                source=package.open(member) if system=='Windows' else package.extractfile(member)
                with source,pending.open('xb') as output:
                    written=0
                    while chunk:=source.read(1024**2):
                        written+=len(chunk)
                        if written>size:raise RuntimeError('encryption executable size mismatch')
                        output.write(chunk)
                    output.flush();os.fsync(output.fileno())
                if written!=size:raise RuntimeError('encryption executable is truncated')
                checksum=digest(pending)
                if target.exists() or target.is_symlink():
                    if digest(target)!=checksum:raise RuntimeError('installed encryption executable differs from its pinned release')
                else:pending.chmod(0o755);os.replace(pending,target)
                result[name]={'path':str(target),'sha256':checksum,'bytes':size}
            finally:pending.unlink(missing_ok=True)
    manifest={'schema':'hv-backup-encryption/1','version':VERSION,'system':system,'archiveSha256':release['sha256'],'binaries':result}
    target=root/'encryption.json';pending=target.with_name(target.name+'.'+uuid.uuid4().hex+'.pending')
    try:
        with pending.open('x') as output:json.dump(manifest,output,indent=2);output.write('\n');output.flush();os.fsync(output.fileno())
        pending.chmod(0o644);os.replace(pending,target)
    finally:pending.unlink(missing_ok=True)
    return manifest
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,required=True);args=parser.parse_args()
    if platform.system() not in RELEASES or platform.machine().lower() not in ('amd64','x86_64'):raise RuntimeError('pinned encryption tools require Windows or Linux amd64')
    if not args.root.is_absolute() or args.root.is_symlink():raise RuntimeError('choose an absolute regular encryption runtime directory')
    value=install(args.root.resolve(),platform.system());print(json.dumps({'installed':True,'version':value['version'],'system':value['system'],'keysCreated':False}))
if __name__=='__main__':main()
