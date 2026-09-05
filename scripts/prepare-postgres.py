#!/usr/bin/env python3
"""Prepare a workspace-resident PostgreSQL runtime for private staging."""
import argparse
import json
import os
from pathlib import Path
import pwd
import secrets
import shlex
import subprocess
import time

USERNAME = "hv-postgres"
UID = 61540
PORT = 55432
def run(*args, **kwargs): return subprocess.run(args, check=True, **kwargs)
def ensure_user():
    try:
        user = pwd.getpwnam(USERNAME)
        if user.pw_uid != UID: raise RuntimeError("unexpected PostgreSQL service uid")
    except KeyError:
        try: pwd.getpwuid(UID)
        except KeyError: pass
        else: raise RuntimeError("PostgreSQL service uid already belongs to another account")
        run("useradd", "--system", "--no-create-home", "--uid", str(UID), "--shell", "/usr/sbin/nologin", USERNAME)
    return pwd.getpwnam(USERNAME)
def prepare(root):
    root.mkdir(parents=True, exist_ok=True)
    root = root.resolve()
    dist = root / "postgres-dist"
    pg = dist / "usr/lib/postgresql/15/bin"
    if not (pg / "postgres").is_file(): raise RuntimeError("extract the verified Debian PostgreSQL packages before setup")
    libs = str(dist / "usr/lib/x86_64-linux-gnu")
    env = dict(os.environ, LD_LIBRARY_PATH=libs)
    user = ensure_user()
    data = root / "postgres-data"
    data.mkdir(mode=0o700, exist_ok=True)
    os.chown(data, user.pw_uid, user.pw_gid)
    settings = root / "postgres-secrets.json"
    if settings.exists(): passwords = json.loads(settings.read_text())
    else:
        passwords = {name: secrets.token_hex(32) for name in ("hv_admin", "hv_api", "hv_worker")}
        descriptor = os.open(settings, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as file: json.dump(passwords, file)
    if not (data / "PG_VERSION").exists():
        password_file = root / "init-password"
        descriptor = os.open(password_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as file: file.write(passwords["hv_admin"])
        os.chown(password_file, user.pw_uid, user.pw_gid)
        try:
            run("runuser", "-u", USERNAME, "--", str(pg / "initdb"), "-D", str(data),
                "-L", str(dist / "usr/share/postgresql/15"), "--locale=C", "--encoding=UTF8",
                "--data-checksums", "--username=hv_admin", "--auth-host=scram-sha-256",
                "--auth-local=scram-sha-256", "--pwfile=" + str(password_file), env=env)
        finally: password_file.unlink(missing_ok=True)
        with (data / "postgresql.conf").open("a") as file:
            file.write("\nlisten_addresses = '127.0.0.1'\nport = 55432\nunix_socket_directories = ''\n"
                       "max_connections = 60\nshared_buffers = '128MB'\npassword_encryption = 'scram-sha-256'\n"
                       "log_statement = 'none'\nlog_min_error_statement = 'panic'\n")
    startup = root / "run-postgres.py"
    startup.write_text("""#!/usr/bin/env python3
import os,pwd,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
try:
    account=pwd.getpwnam("hv-postgres")
    if account.pw_uid != 61540: raise RuntimeError("unexpected PostgreSQL uid")
except KeyError:
    try: pwd.getpwuid(61540)
    except KeyError: pass
    else: raise RuntimeError("PostgreSQL uid is already assigned")
    subprocess.run(["useradd","--system","--no-create-home","--uid","61540","--shell","/usr/sbin/nologin","hv-postgres"],check=True)
dist=root/"postgres-dist"
os.environ["LD_LIBRARY_PATH"]=str(dist/"usr/lib/x86_64-linux-gnu")
os.execvp("runuser",["runuser","-u","hv-postgres","--",str(dist/"usr/lib/postgresql/15/bin/postgres"),"-D",str(root/"postgres-data")])
""")
    config = Path("/etc/zo/supervisord-user.conf")
    section = "\n[program:rough-cut-storage-postgres]\ncommand=python3 " + str(startup) + """
directory=/
autostart=true
autorestart=true
startsecs=2
stopsignal=INT
stopasgroup=true
killasgroup=true
stopwaitsecs=60
stdout_logfile=/dev/shm/rough-cut-storage-postgres.log
stderr_logfile=/dev/shm/rough-cut-storage-postgres_err.log
"""
    current = config.read_text()
    if "[program:rough-cut-storage-postgres]" not in current:
        with config.open("a") as file: file.write(section)
        run("supervisorctl", "-c", str(config), "reread")
        run("supervisorctl", "-c", str(config), "update", "rough-cut-storage-postgres")
    status = subprocess.run(["supervisorctl", "-c", str(config), "status", "rough-cut-storage-postgres"], capture_output=True, text=True)
    if "RUNNING" not in status.stdout and "STARTING" not in status.stdout:
        run("supervisorctl", "-c", str(config), "start", "rough-cut-storage-postgres")
    # This copy lets deployment bootstrap restore only this program after a host reset.
    (root / "postgres-supervisor.conf").write_text(section)
    psql = pg / "psql"
    env["PGPASSWORD"] = passwords["hv_admin"]
    env["PGCONNECT_TIMEOUT"] = "3"
    tls_directory = root / "database-tls"
    if (tls_directory / "ca.pem").exists() and "# Rough Cut database mTLS" in (data / "postgresql.conf").read_text():
        env.update(PGSSLMODE="verify-full",PGSSLROOTCERT=str(tls_directory/"ca.pem"),
            PGSSLCERT=str(tls_directory/"hv_admin.pem"),PGSSLKEY=str(tls_directory/"hv_admin-key.pem"))
    command = [str(psql), "-h", "127.0.0.1", "-p", str(PORT), "-U", "hv_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"]
    for attempt in range(600):
        result = subprocess.run(command + ["-c", "SELECT 1"], env=env, capture_output=True, text=True)
        if result.returncode == 0: break
        if attempt == 599: raise RuntimeError("PostgreSQL did not become ready")
        time.sleep(1)
    databases = subprocess.check_output(command + ["-c", "SELECT datname FROM pg_database"], env=env, text=True).splitlines()
    if "hollywood_video" not in databases:
        run(*command, "-c", "CREATE DATABASE hollywood_video", env=env)
    roles = subprocess.check_output(command + ["-c", "SELECT rolname FROM pg_roles"], env=env, text=True).splitlines()
    for name in ("hv_api", "hv_worker"):
        if name not in roles:
            # Passwords travel through stdin, never a process argument or printed result.
            sql = f"CREATE ROLE {name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '{passwords[name]}';"
            run(*command, input=sql, text=True, env=env, stdout=subprocess.DEVNULL)
    variables = {
        "HV_PG_ADMIN_URL": f"postgres://hv_admin:{passwords['hv_admin']}@127.0.0.1:{PORT}/hollywood_video",
        "HV_API_DATABASE_URL": f"postgres://hv_api:{passwords['hv_api']}@127.0.0.1:{PORT}/hollywood_video",
        "HV_WORKER_DATABASE_URL": f"postgres://hv_worker:{passwords['hv_worker']}@127.0.0.1:{PORT}/hollywood_video",
    }
    if env.get("PGSSLMODE") == "verify-full": variables["HV_DATABASE_TLS_DIR"] = str(tls_directory)
    path = root / "database.env"
    descriptor = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w") as file:
        file.write("\n".join(key + "=" + shlex.quote(value) for key,value in variables.items()) + "\n")
    print(json.dumps({"ready":True,"port":PORT,"binding":"127.0.0.1","dataChecksums":True,"database":"hollywood_video","serviceUser":USERNAME}))
if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,required=True)
    arguments=parser.parse_args()
    prepare(arguments.root)
