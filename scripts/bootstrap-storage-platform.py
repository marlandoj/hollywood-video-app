#!/usr/bin/env python3
"""Restore existing private storage service registrations after a Zo restart.

This does not initialize data, generate credentials, or change live app storage.
Call it from the managed API startup before connecting to PostgreSQL/S3.
"""
import argparse
import configparser
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
import ssl
import urllib.request

CONFIG = Path("/etc/zo/supervisord-user.conf")
SERVICES = {"rough-cut-storage-postgres": ("run-postgres.py", "INT", 60, 2),
            "rough-cut-storage-objects": ("run-object-storage.py", "TERM", 45, 3)}

def section(name, root):
    script, signal, wait, start = SERVICES[name]
    return f"""
[program:{name}]
command=python3 {root / script}
directory=/
autostart=true
autorestart=true
startsecs={start}
stopsignal={signal}
stopasgroup=true
killasgroup=true
stopwaitsecs={wait}
stdout_logfile=/dev/shm/{name}.log
stderr_logfile=/dev/shm/{name}_err.log
"""

def merged_config(current, root):
    parsed = configparser.ConfigParser(interpolation=None)
    parsed.read_string(current)
    result, added = current, []
    for name, (script, _, _, _) in SERVICES.items():
        key = "program:" + name
        if parsed.has_section(key):
            if parsed.get(key, "command") != "python3 " + str(root / script):
                raise RuntimeError("storage service name is already assigned to another command")
        else:
            result += section(name, root)
            added.append(name)
    return result, added

def require_existing(root):
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(root)):
        raise RuntimeError("unsupported storage runtime path")
    for name in ("postgres-data/PG_VERSION", "postgres-dist/usr/lib/postgresql/15/bin/psql",
                 "run-postgres.py", "run-object-storage.py", "postgres-secrets.json",
                 "database-tls/ca.pem", "database-tls/hv_admin.pem", "database-tls/hv_admin-key.pem",
                 "platform-pki/ca.pem", "object-tls/rustfs_cert.pem", "object-tls/rustfs_key.pem",
                 "object-secrets.json"):
        path = root / name
        if not path.is_file() or path.is_symlink():
            raise RuntimeError("existing storage runtime is incomplete: " + name)
    for name in ("postgres-data", "object-data"):
        if not (root / name).is_dir() or (root / name).is_symlink():
            raise RuntimeError("existing storage data directory is unavailable")
    if (root / "postgres-data/PG_VERSION").read_text().strip() != "15":
        raise RuntimeError("storage database major version is incompatible")

def control(action, *names):
    result = subprocess.run(["supervisorctl", "-c", str(CONFIG), action, *names],
                            capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError("storage supervisor action failed: " + action)
    return result.stdout

def ready(root, deadline):
    secrets = json.loads((root / "postgres-secrets.json").read_text())
    tls = root / "database-tls"
    environment = {"PATH": "/usr/local/bin:/usr/bin:/bin",
        "LD_LIBRARY_PATH": str(root / "postgres-dist/usr/lib/x86_64-linux-gnu"),
        "PGPASSWORD": secrets["hv_admin"], "PGCONNECT_TIMEOUT": "3", "PGSSLMODE": "verify-full",
        "PGSSLROOTCERT": str(tls / "ca.pem"), "PGSSLCERT": str(tls / "hv_admin.pem"),
        "PGSSLKEY": str(tls / "hv_admin-key.pem")}
    command = [str(root / "postgres-dist/usr/lib/postgresql/15/bin/psql"),
               "-h", "127.0.0.1", "-p", "55432", "-U", "hv_admin", "-d", "hollywood_video",
               "-At", "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1"]
    context = ssl.create_default_context(cafile=str(root / "platform-pki/ca.pem"))
    while time.monotonic() < deadline:
        postgres = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=5)
        objects = False
        try:
            with urllib.request.urlopen("https://127.0.0.1:59000/health", context=context, timeout=3) as response:
                objects = response.status == 200
        except (OSError, TimeoutError):
            pass
        if postgres.returncode == 0 and postgres.stdout.strip() == "1" and objects:
            return
        time.sleep(1)
    raise RuntimeError("private storage did not become ready before the startup deadline")

def bootstrap(root):
    root = root.resolve(strict=True)
    require_existing(root)
    started = time.monotonic()
    lock = os.open(root / "bootstrap.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() - started > 900:
                    raise RuntimeError("another storage bootstrap exceeded its deadline")
                time.sleep(1)
        current = CONFIG.read_text()
        merged, added = merged_config(current, root)
        if added:
            metadata = CONFIG.stat()
            descriptor, temporary = tempfile.mkstemp(prefix=".storage-bootstrap-", dir=CONFIG.parent)
            try:
                os.fchmod(descriptor, stat.S_IMODE(metadata.st_mode))
                os.fchown(descriptor, metadata.st_uid, metadata.st_gid)
                with os.fdopen(descriptor, "w") as file:
                    file.write(merged)
                    file.flush()
                    os.fsync(file.fileno())
                if CONFIG.read_text() != current:
                    raise RuntimeError("supervisor configuration changed during storage bootstrap")
                os.replace(temporary, CONFIG)
                directory = os.open(CONFIG.parent, os.O_RDONLY)
                try: os.fsync(directory)
                finally: os.close(directory)
            finally:
                Path(temporary).unlink(missing_ok=True)
        control("reread")
        control("update", *SERVICES)
        for name in SERVICES:
            status = subprocess.run(["supervisorctl", "-c", str(CONFIG), "status", name],
                                    capture_output=True, text=True, timeout=10).stdout
            if not any(state in status.split() for state in ("RUNNING", "STARTING")):
                control("start", name)
        ready(root, time.monotonic() + 600)
        return {"ready": True, "restoredRegistrations": added, "tlsVerified": True,
                "elapsedSeconds": round(time.monotonic() - started, 3)}
    finally:
        os.close(lock)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(bootstrap(args.root)))
