#!/usr/bin/env python3
"""Prepare private, workspace-resident S3-compatible storage with TLS."""
import argparse, json, os, pwd, secrets, shlex, ssl, subprocess, time, urllib.request
from pathlib import Path
USERNAME, UID, PORT = "hv-object-store", 61541, 59000
def run(*args): return subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
def user():
    try:
        value = pwd.getpwnam(USERNAME)
        if value.pw_uid != UID: raise RuntimeError("unexpected object service uid")
    except KeyError:
        try: pwd.getpwuid(UID)
        except KeyError: pass
        else: raise RuntimeError("object service uid is already assigned")
        run("useradd", "--system", "--no-create-home", "--uid", str(UID), "--shell", "/usr/sbin/nologin", USERNAME)
    return pwd.getpwnam(USERNAME)
def prepare(root):
    root = root.resolve()
    binary = root / "rustfs-dist/rustfs"
    if not binary.is_file(): raise RuntimeError("extract the verified RustFS release before setup")
    account = user()
    data = root / "object-data"
    data.mkdir(mode=0o700, exist_ok=True)
    os.chown(data, account.pw_uid, account.pw_gid)
    pki = root / "platform-pki"
    pki.mkdir(mode=0o700, exist_ok=True)
    previous_mask = os.umask(0o077)
    try:
        if not (pki / "ca.pem").exists():
            run("openssl", "req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", "3650",
                "-keyout", str(pki / "ca-key.pem"), "-out", str(pki / "ca.pem"), "-subj", "/CN=Rough Cut Private Storage CA")
        tls = root / "object-tls"
        tls.mkdir(mode=0o750, exist_ok=True)
        if not (tls / "rustfs_cert.pem").exists():
            run("openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", str(tls / "rustfs_key.pem"),
                "-out", str(tls / "server.csr"), "-subj", "/CN=localhost")
            extension = tls / "server.ext"
            extension.write_text("subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n")
            run("openssl", "x509", "-req", "-in", str(tls / "server.csr"), "-CA", str(pki / "ca.pem"),
                "-CAkey", str(pki / "ca-key.pem"), "-CAcreateserial", "-out", str(tls / "rustfs_cert.pem"),
                "-days", "365", "-sha256", "-extfile", str(extension))
        os.chown(tls, account.pw_uid, account.pw_gid)
        tls.chmod(0o750)
        for file in tls.iterdir():
            os.chown(file, account.pw_uid, account.pw_gid)
            file.chmod(0o600)
        settings = root / "object-secrets.json"
        if not settings.exists():
            settings.write_text(json.dumps({"accessKeyId": "hv-" + secrets.token_hex(12), "secretAccessKey": secrets.token_hex(32)}))
        settings.chmod(0o600)
        credentials = json.loads(settings.read_text())
        variables = {"HV_S3_ENDPOINT": f"https://127.0.0.1:{PORT}", "HV_S3_BUCKET": "rough-cut-private",
            "HV_S3_REGION": "us-east-1", "HV_S3_ACCESS_KEY_ID": credentials["accessKeyId"],
            "HV_S3_SECRET_ACCESS_KEY": credentials["secretAccessKey"], "NODE_EXTRA_CA_CERTS": str(pki / "ca.pem"),
            "HV_STORAGE_CA_PATH": str(pki / "ca.pem")}
        (root / "object.env").write_text("\n".join(key + "=" + shlex.quote(value) for key,value in variables.items()) + "\n")
        (root / "object.env").chmod(0o600)
    finally: os.umask(previous_mask)
    startup = root / "run-object-storage.py"
    startup.write_text('''#!/usr/bin/env python3
import json, os, pwd, subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
try:
    account=pwd.getpwnam("hv-object-store")
    if account.pw_uid!=61541: raise RuntimeError("unexpected object service uid")
except KeyError:
    try: pwd.getpwuid(61541)
    except KeyError: pass
    else: raise RuntimeError("object service uid already assigned")
    subprocess.run(["useradd","--system","--no-create-home","--uid","61541","--shell","/usr/sbin/nologin","hv-object-store"],check=True)
keys=json.loads((root/"object-secrets.json").read_text())
environment={"PATH":"/usr/local/bin:/usr/bin:/bin","RUSTFS_ACCESS_KEY":keys["accessKeyId"],"RUSTFS_SECRET_KEY":keys["secretAccessKey"],
    "RUSTFS_CONSOLE_ENABLE":"false","RUSTFS_OBS_LOGGER_LEVEL":"warn","RUSTFS_REGION":"us-east-1"}
os.execve("/usr/sbin/runuser",["runuser","-u","hv-object-store","--",str(root/"rustfs-dist/rustfs"),"server",
    "--address","127.0.0.1:59000","--console-address","127.0.0.1:59001","--tls-path",str(root/"object-tls"),str(root/"object-data")],environment)
''')
    section = f"""
[program:rough-cut-storage-objects]
command=python3 {startup}
directory=/
autostart=true
autorestart=true
startsecs=3
stopsignal=TERM
stopasgroup=true
killasgroup=true
stopwaitsecs=45
stdout_logfile=/dev/shm/rough-cut-storage-objects.log
stderr_logfile=/dev/shm/rough-cut-storage-objects_err.log
"""
    config = Path("/etc/zo/supervisord-user.conf")
    if "[program:rough-cut-storage-objects]" not in config.read_text():
        with config.open("a") as file: file.write(section)
        run("supervisorctl", "-c", str(config), "reread")
        run("supervisorctl", "-c", str(config), "update", "rough-cut-storage-objects")
    status = subprocess.run(["supervisorctl", "-c", str(config), "status", "rough-cut-storage-objects"], capture_output=True, text=True).stdout
    if "RUNNING" not in status and "STARTING" not in status:
        run("supervisorctl", "-c", str(config), "start", "rough-cut-storage-objects")
    (root / "object-supervisor.conf").write_text(section)
    context = ssl.create_default_context(cafile=str(pki / "ca.pem"))
    for attempt in range(30):
        try:
            with urllib.request.urlopen(f"https://127.0.0.1:{PORT}/health", context=context, timeout=2) as result:
                if result.status == 200: break
        except Exception:
            if attempt == 29: raise RuntimeError("object storage did not become ready")
            time.sleep(0.5)
    subprocess.run(["python3", str(Path(__file__).with_name("prepare-object-bucket.py"))], env=dict(os.environ, **variables), check=True)
    print(json.dumps({"ready":True,"endpoint":f"https://127.0.0.1:{PORT}","serviceUser":USERNAME,"tlsVerified":True,"consoleEnabled":False}))
if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,required=True)
    arguments=parser.parse_args()
    prepare(arguments.root)
