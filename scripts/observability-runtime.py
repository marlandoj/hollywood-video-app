#!/usr/bin/env python3
"""Prepare and restore the studio's private observability services on Zo."""
import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request

CONFIG=Path('/etc/zo/supervisord-user.conf')
USER='hv-observability'
SERVICES={'jaeger':('rough-cut-observability-traces','jaeger','2.20.0','400MiB'),
          'collector':('rough-cut-observability-collector','otelcol-contrib','0.160.0','200MiB'),
          'prometheus':('rough-cut-observability-metrics','prometheus','3.14.0','512MiB')}

def regular(path):
    if path.is_symlink() or not path.is_file():raise RuntimeError('observability file is not regular')
    if path.stat().st_mode & 0o022:raise RuntimeError('observability configuration must not be writable by other users')

def sha(path):
    regular(path)
    with path.open('rb') as file:return hashlib.file_digest(file,'sha256').hexdigest()

def atomic(path,data,mode=0o644,expected=None):
    descriptor,temporary=tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
    try:
        os.fchmod(descriptor,mode)
        with os.fdopen(descriptor,'wb') as file:file.write(data);file.flush();os.fsync(file.fileno())
        if expected is not None and path.read_bytes()!=expected:raise RuntimeError('configuration changed during observability setup')
        os.replace(temporary,path)
        directory=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:Path(temporary).unlink(missing_ok=True)

def directory(path,mode=0o755):
    if path.is_symlink() or (path.exists() and not path.is_dir()):raise RuntimeError('unsafe observability directory')
    path.mkdir(parents=True,exist_ok=True,mode=mode)

def source_files(repo):
    names=['scripts/observability-runtime.py','scripts/install-observability-runtime.py',*[f'infra/observability/{name}.yaml' for name in SERVICES]]
    deployed=repo/'.deployed-sha'
    if deployed.exists():
        regular(deployed);identity=deployed.read_text().strip()
        files={}
        for name in names:regular(repo/name);files[name]=(repo/name).read_bytes()
    else:
        identity=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
        files={name:subprocess.check_output(['git','show',identity+':'+name],cwd=repo) for name in names}
    if not re.fullmatch('[a-f0-9]{40}',identity):raise RuntimeError('observability source is not an immutable commit')
    return identity,files

def binaries(root):
    manifest=root/'binaries.json';regular(manifest)
    value=json.loads(manifest.read_text())
    if value.get('schema')!='hv-observability-binaries/1' or value.get('root')!=str(root):raise RuntimeError('invalid observability binary manifest')
    found={}
    for service,(_,name,version,_) in SERVICES.items():
        releases=[item for item in value['releases'] if item['name']==name and item['version']==version]
        if len(releases)!=1:raise RuntimeError('required observability version is unavailable')
        record=releases[0]['binaries'][name];path=Path(record['path'])
        if path!=root/'bin'/(name+'-'+version) or sha(path)!=record['sha256']:raise RuntimeError('observability binary integrity failed')
        found[service]=path
    prometheus=next(item for item in value['releases'] if item['name']=='prometheus' and item['version']=='3.14.0')
    record=prometheus['binaries']['promtool'];path=root/'bin/promtool-3.14.0'
    if record['path']!=str(path) or sha(path)!=record['sha256']:raise RuntimeError('observability validation binary integrity failed')
    found['promtool']=path
    return found

def service_environment(root,service):
    return {'PATH':'/usr/local/bin:/usr/bin:/bin','HV_OBSERVABILITY_ROOT':str(root),'GOMEMLIMIT':SERVICES[service][3]}

def configuration(root):
    path=root/'runtime.json';regular(path);value=json.loads(path.read_text())
    if value.get('schema')!='hv-observability-runtime/1' or not re.fullmatch('[a-f0-9]{40}',value.get('sourceSha','')):
        raise RuntimeError('invalid observability runtime manifest')
    directory=root/'config'/value['sourceSha']
    if directory.is_symlink():raise RuntimeError('unsafe observability configuration directory')
    for name in SERVICES:
        if sha(directory/(name+'.yaml'))!=value['configSha256'][name]:raise RuntimeError('observability configuration integrity failed')
    if sha(root/'run-observability.py')!=value['launcherSha256']:raise RuntimeError('observability launcher integrity failed')
    return value,directory

def prepare(root,repo):
    import pwd
    identity,files=source_files(repo)
    installer=root/'install-observability-runtime.py'
    atomic(installer,files['scripts/install-observability-runtime.py'])
    if not (root/'binaries.json').is_file() or any(not (root/'bin'/(name+'-'+version)).is_file() for _,name,version,_ in SERVICES.values()) or not (root/'bin/promtool-3.14.0').is_file():
        subprocess.run(['python3',str(installer),'--root',str(root)],env={'PATH':'/usr/local/bin:/usr/bin:/bin'},check=True,timeout=180)
    executables=binaries(root)
    try:account=pwd.getpwnam(USER)
    except KeyError:
        try:pwd.getpwuid(61542)
        except KeyError:pass
        else:raise RuntimeError('observability service uid is already assigned')
        subprocess.run(['useradd','--system','--uid','61542','--user-group','--home-dir',str(root/'data'),'--no-create-home','--shell','/usr/sbin/nologin',USER],check=True,capture_output=True)
        account=pwd.getpwnam(USER)
    if account.pw_uid!=61542 or account.pw_shell not in ('/usr/sbin/nologin','/sbin/nologin'):
        raise RuntimeError('observability service account differs from its assigned identity')
    for folder in ('data','data/jaeger','data/jaeger/keys','data/jaeger/values','data/prometheus'):
        path=root/folder;directory(path,0o750);os.chown(path,account.pw_uid,account.pw_gid);path.chmod(0o750)
    config=root/'config'/identity;directory(config)
    for name in SERVICES:
        target=config/(name+'.yaml');data=files['infra/observability/'+name+'.yaml']
        if target.exists() and target.read_bytes()!=data:raise RuntimeError('immutable observability configuration changed')
        if not target.exists():atomic(target,data)
    for name in ('jaeger','collector'):
        subprocess.run([str(executables[name]),'validate','--config',str(config/(name+'.yaml'))],env=service_environment(root,name),check=True,capture_output=True,timeout=30)
    promtool=executables['promtool']
    subprocess.run([str(promtool),'check','config',str(config/'prometheus.yaml')],env=service_environment(root,'prometheus'),check=True,capture_output=True,timeout=30)
    previous=json.loads((root/'runtime.json').read_text()) if (root/'runtime.json').exists() else None
    atomic(root/'run-observability.py',files['scripts/observability-runtime.py'])
    value={'schema':'hv-observability-runtime/1','sourceSha':identity,'configSha256':{name:sha(config/(name+'.yaml')) for name in SERVICES},
           'launcherSha256':sha(root/'run-observability.py')}
    atomic(root/'runtime.json',(json.dumps(value,indent=2)+'\n').encode())
    return previous is not None and previous!=value

def command(root,service):
    return '/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin python3 '+str(root/'run-observability.py')+' --root '+str(root)+' --run '+service

def section(root,service):
    name=SERVICES[service][0]
    return f'''[program:{name}]
command={command(root,service)}
directory=/
user={USER}
autostart=true
autorestart=true
startsecs=1
stopsignal=TERM
stopasgroup=true
killasgroup=true
stopwaitsecs=30
stdout_logfile=/dev/shm/{name}.log
stderr_logfile=/dev/shm/{name}_err.log
stdout_logfile_maxbytes=2MB
stderr_logfile_maxbytes=2MB
stdout_logfile_backups=1
stderr_logfile_backups=1
'''

def merged_configuration(current,root):
    parsed=configparser.ConfigParser(interpolation=None);parsed.read_string(current)
    result=current;changed=[]
    for service,(name,_,_,_) in SERVICES.items():
        key='program:'+name;replacement=section(root,service)
        if parsed.has_section(key):
            if parsed.get(key,'command')!=command(root,service):raise RuntimeError('observability service belongs to another command')
            expression=r'(?ms)^\['+re.escape(key)+r'\]\n.*?(?=^\[|\Z)'
            match=re.search(expression,result)
            if not match:raise RuntimeError('observability section cannot be safely replaced')
            if match.group(0).strip()==replacement.strip():continue
            result=result[:match.start()]+replacement+'\n'+result[match.end():]
        else:result+='\n'+replacement
        changed.append(name)
    return result,changed

def control(action,*names):
    result=subprocess.run(['supervisorctl','-c',str(CONFIG),action,*names],capture_output=True,text=True,timeout=45)
    if result.returncode:raise RuntimeError('observability supervisor action failed: '+action)
    return result.stdout

def restore(root,restart=False):
    configuration(root);binaries(root)
    current=CONFIG.read_text();updated,changed=merged_configuration(current,root)
    if updated!=current:
        metadata=CONFIG.stat()
        atomic(CONFIG,updated.encode(),metadata.st_mode & 0o777,expected=current.encode())
        os.chown(CONFIG,metadata.st_uid,metadata.st_gid)
    control('reread');control('update',*[value[0] for value in SERVICES.values()])
    for name,_,_,_ in SERVICES.values():
        result=subprocess.run(['supervisorctl','-c',str(CONFIG),'status',name],capture_output=True,text=True,timeout=5).stdout.split()
        if restart and 'RUNNING' in result:control('restart',name)
        elif not any(state in result for state in ('RUNNING','STARTING')):control('start',name)
    deadline=time.monotonic()+60
    endpoints=['http://127.0.0.1:15333/','http://127.0.0.1:15686/api/services','http://127.0.0.1:15909/-/ready']
    while time.monotonic()<deadline:
        try:
            for endpoint in endpoints:
                with urllib.request.urlopen(endpoint,timeout=2) as response:
                    if response.status!=200:raise RuntimeError('not ready')
            return {'ready':True,'restoredRegistrations':changed,'sourceSha':configuration(root)[0]['sourceSha']}
        except Exception:time.sleep(1)
    raise RuntimeError('observability services did not become ready')

def run(root,service):
    _,config=configuration(root);executable=binaries(root)[service]
    if service=='prometheus':
        arguments=['--config.file='+str(config/'prometheus.yaml'),'--storage.tsdb.path='+str(root/'data/prometheus'),
          '--storage.tsdb.retention.time=2d','--storage.tsdb.retention.size=2GB','--web.listen-address=127.0.0.1:15909',
          '--query.timeout=5s','--query.max-concurrency=4','--query.max-samples=1000000','--log.level=warn']
    else:arguments=['--config',str(config/(service+'.yaml'))]
    os.execve(executable,[str(executable),*arguments],service_environment(root,service))

def main():
    import fcntl
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True);parser.add_argument('--repo',type=Path)
    parser.add_argument('--prepare',action='store_true');parser.add_argument('--restore',action='store_true');parser.add_argument('--run',choices=SERVICES)
    args=parser.parse_args()
    if not args.root.is_absolute() or args.root.is_symlink() or not re.fullmatch(r'/[A-Za-z0-9_./-]+',str(args.root)):
        raise RuntimeError('unsupported observability runtime path')
    root=args.root.resolve();directory(root)
    if args.run:
        if args.prepare or args.restore:raise RuntimeError('run cannot change configuration')
        run(root,args.run);return
    if not (args.prepare or args.restore):parser.error('choose prepare, restore, or run')
    descriptor=os.open(root/'bootstrap.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        try:fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:print(json.dumps({'pending':True}));return
        changed=False
        if args.prepare:
            if not args.repo:parser.error('prepare requires the immutable app source directory')
            changed=prepare(root,args.repo.resolve(strict=True))
        print(json.dumps(restore(root,changed) if args.restore else {'prepared':True,'servicesStarted':False}))
    finally:os.close(descriptor)

if __name__=='__main__':main()
