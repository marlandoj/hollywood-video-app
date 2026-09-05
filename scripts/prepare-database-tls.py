#!/usr/bin/env python3
"""Require matching client certificates and SCRAM credentials for private PostgreSQL."""
import argparse, json, os, pwd, shlex, shutil, subprocess, time
from pathlib import Path

def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **kwargs)

def prepare(root):
    root = root.resolve()
    pki, clients, data = root / "platform-pki", root / "database-tls", root / "postgres-data"
    if not (pki / "ca.pem").exists(): raise RuntimeError("prepare the private object service CA before database TLS")
    account = pwd.getpwnam("hv-postgres")
    pg = root / "postgres-dist/usr/lib/postgresql/15/bin"
    previous_mask = os.umask(0o077)
    try:
        clients.mkdir(mode=0o700, exist_ok=True)
        shutil.copyfile(pki / "ca.pem", clients / "ca.pem")
        for identity in ("server", "hv_admin", "hv_api", "hv_worker"):
            cert, key = clients / (identity + ".pem"), clients / (identity + "-key.pem")
            if cert.exists() and key.exists(): continue
            request, extension = clients / (identity + ".csr"), clients / (identity + ".ext")
            run("openssl","req","-new","-newkey","rsa:2048","-nodes","-keyout",str(key),"-out",str(request),
                "-subj","/CN=" + ("localhost" if identity == "server" else identity))
            extension.write_text("basicConstraints=CA:FALSE\nextendedKeyUsage=" + ("serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n" if identity == "server" else "clientAuth\n"))
            run("openssl","x509","-req","-in",str(request),"-CA",str(pki/"ca.pem"),"-CAkey",str(pki/"ca-key.pem"),
                "-CAcreateserial","-out",str(cert),"-days","365","-sha256","-extfile",str(extension))
        for source,name in ((clients/"server.pem","server.crt"),(clients/"server-key.pem","server.key"),(clients/"ca.pem","storage-ca.crt")):
            destination = data/name
            shutil.copyfile(source,destination); destination.chmod(0o600); os.chown(destination,account.pw_uid,account.pw_gid)
    finally: os.umask(previous_mask)
    config, hba = data / "postgresql.conf", data / "pg_hba.conf"
    original_config, original_hba = config.read_text(), hba.read_text()
    marker = "# Rough Cut database mTLS"
    if marker not in original_config:
        with config.open("a") as file:
            file.write("\n" + marker + "\nssl = on\nssl_cert_file = 'server.crt'\nssl_key_file = 'server.key'\n"
                       "ssl_ca_file = 'storage-ca.crt'\nssl_min_protocol_version = 'TLSv1.2'\n")
    hba.write_text("hostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject\n"
                  "hostssl all hv_admin,hv_api,hv_worker 127.0.0.1/32 scram-sha-256 clientcert=verify-full\n"
                  "hostssl replication hv_admin 127.0.0.1/32 scram-sha-256 clientcert=verify-full\n")
    env = dict(os.environ, LD_LIBRARY_PATH=str(root/"postgres-dist/usr/lib/x86_64-linux-gnu"))
    reload_command = ["runuser","-u","hv-postgres","--",str(pg/"pg_ctl"),"-D",str(data),"reload"]
    passwords = json.loads((root/"postgres-secrets.json").read_text())
    command = [str(pg/"psql"),"-h","127.0.0.1","-p","55432","-U","hv_admin","-d","hollywood_video","-At","-v","ON_ERROR_STOP=1",
        "-c","select ssl,version from pg_stat_ssl where pid = pg_backend_pid()"]
    env.update(PGPASSWORD=passwords["hv_admin"],PGCONNECT_TIMEOUT="3",PGSSLMODE="verify-full",PGSSLROOTCERT=str(clients/"ca.pem"),
               PGSSLCERT=str(clients/"hv_admin.pem"),PGSSLKEY=str(clients/"hv_admin-key.pem"))
    try:
        run(*reload_command,env=env)
        for attempt in range(20):
            result = subprocess.run(command,env=env,capture_output=True,text=True,timeout=8)
            if result.returncode == 0 and result.stdout.startswith("t|TLS"): break
            if attempt == 19: raise RuntimeError("verified database TLS connection failed")
            time.sleep(0.5)
        no_certificate = dict(env)
        no_certificate.pop("PGSSLCERT"); no_certificate.pop("PGSSLKEY")
        if subprocess.run(command,env=no_certificate,capture_output=True,timeout=8).returncode == 0:
            raise RuntimeError("database accepted a connection without a client certificate")
        cleartext = dict(env, PGSSLMODE="disable")
        if subprocess.run(command,env=cleartext,capture_output=True,timeout=8).returncode == 0:
            raise RuntimeError("database accepted a cleartext connection")
        wrong_certificate = dict(env, PGSSLCERT=str(clients/"hv_worker.pem"),PGSSLKEY=str(clients/"hv_worker-key.pem"))
        if subprocess.run(command,env=wrong_certificate,capture_output=True,timeout=8).returncode == 0:
            raise RuntimeError("database accepted a client certificate for another role")
    except Exception:
        config.write_text(original_config); hba.write_text(original_hba)
        run(*reload_command,env=env)
        raise
    path=root/"database.env"
    lines=[line for line in path.read_text().splitlines() if not line.startswith("HV_DATABASE_TLS_DIR=")]
    lines.append("HV_DATABASE_TLS_DIR="+shlex.quote(str(clients)))
    path.write_text("\n".join(lines)+"\n"); path.chmod(0o600)
    print(json.dumps({"databaseTls":True,"minimumVersion":"TLSv1.2","clientCertificateMatchesRole":True,
        "cleartextDenied":True,"missingCertificateDenied":True,"wrongCertificateDenied":True}))
if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,required=True)
    arguments=parser.parse_args()
    prepare(arguments.root)
