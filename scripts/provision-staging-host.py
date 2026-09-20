#!/usr/bin/env python3
"""Provision an empty Linux host as a private Rough Cut staging runtime.

Zo's staging runtime was assembled by hand before the loop: its supervisor, its
startup wrappers, its edge, its mTLS identities. This script writes the same shape
from the repository, so a new host (docs/STAGING-LOCAL.md) is reproducible:

  1. a supervisord of its own, with an XML-RPC listener on loopback, that exports
     HV_SUPERVISOR_CONFIG and HV_SUPERVISOR_RPC_URL to every program it starts
     (scripts/host_config.py), and a systemd unit that runs it;
  2. the runtime root: the pinned Bun binary, data directories, the edge
     (infra/staging/edge.ts), the startup wrappers, the mock-only runtime
     configuration and a private CA with the API's server identity and the edge's
     client identity;
  3. secrets.env: a fresh HV_TOKEN_SECRET, plus the provider keys the operator
     entered in the host's operator secrets file, copied by name and never printed;
  4. the api, worker, sweeper and edge programs, registered but not started.

It never overwrites a file that exists: a second run fills in only what is
missing and reports the rest as kept. It starts nothing except supervisord
itself. The first release is installed afterwards by deploy-private-staging.py,
exactly as on Zo.
"""
import argparse
import json
import os
import secrets
import shlex
import shutil
import stat
import subprocess
from pathlib import Path
from urllib.parse import urlsplit
import importlib.util as _hc_util
_hc_spec=_hc_util.spec_from_file_location("host_config",Path(__file__).with_name("host_config.py"));host_config=_hc_util.module_from_spec(_hc_spec);_hc_spec.loader.exec_module(host_config)

# The new host's supervisor listens where Zo's does, so the default RPC URL is right on both.
SUPERVISOR_RPC_PORT = urlsplit(host_config.ZO_SUPERVISOR_RPC_URL).port
PROVIDER_KEYS = ("FAL_KEY", "HV_AZURE_SPEECH_KEY")
EMPTY_PROJECT_STATE = {"version": 1, "projects": [], "reviewLinks": [], "takenDown": [], "takedownLog": []}
REPO = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------- text builders

def supervisor_base(config: Path, port: int = SUPERVISOR_RPC_PORT) -> str:
    rpc = f"http://127.0.0.1:{port}/RPC2"
    return (
        "; Rough Cut private staging supervisor (scripts/provision-staging-host.py).\n"
        "; Programs below are appended by the repository's staging scripts.\n"
        f"[inet_http_server]\nport=127.0.0.1:{port}\n\n"
        f"[supervisorctl]\nserverurl=http://127.0.0.1:{port}\n\n"
        "[supervisord]\nlogfile=/var/log/rough-cut-supervisord.log\npidfile=/run/rough-cut-supervisord.pid\n"
        "nodaemon=false\nuser=root\n"
        f"environment={host_config.CONFIG_ENV}=\"{config}\",{host_config.RPC_ENV}=\"{rpc}\"\n\n"
        "[rpcinterface:supervisor]\nsupervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface\n")


def program_section(name: str, command: str, directory: Path, *, environment: str = "", stopasgroup: bool = True,
                    stopwaitsecs: int = 4, autostart: bool = True) -> str:
    # The same settings Zo's runtime uses for these programs.
    return (f"\n[program:{name}]\ncommand={command}\ndirectory={directory}\nenvironment={environment}\n"
            f"autostart={'true' if autostart else 'false'}\nautorestart=true\nstopsignal=TERM\n"
            f"stopasgroup={'true' if stopasgroup else 'false'}\nstartretries=20\nstartsecs=5\n"
            f"stdout_logfile=/dev/shm/{name}.log\nstderr_logfile=/dev/shm/{name}_err.log\n"
            "stdout_logfile_maxbytes=10MB\nstdout_logfile_backups=5\nkillasgroup=true\n"
            f"stopwaitsecs={stopwaitsecs}\nstderr_logfile_maxbytes=10MB\nstderr_logfile_backups=5\n")


def programs(root: Path, frontend_origin: str) -> dict[str, str]:
    return {
        "rough-cut-staging-api": program_section("rough-cut-staging-api", f"bash {root}/run-api.sh", root,
            environment=f"HV_FRONTEND_ORIGIN=\"{frontend_origin}\""),
        "rough-cut-staging-worker": program_section("rough-cut-staging-worker", f"bash {root}/run-worker.sh", root,
            stopasgroup=False, stopwaitsecs=900),
        "rough-cut-staging-sweeper": program_section("rough-cut-staging-sweeper", f"bash {root}/run-sweeper.sh", root),
        "rough-cut-staging-edge": program_section("rough-cut-staging-edge", f"bash {root}/run-edge.sh", root,
            environment="PORT=\"8081\",HV_EDGE_HOSTNAME=\"127.0.0.1\""),
    }


PREFIX = '#!/usr/bin/env bash\nset -euo pipefail\nR="$(cd "$(dirname "$0")" && pwd)"\n'
WRAPPERS = {
    "run-api.sh": PREFIX + 'set -a; source "$R/secrets.env"; set +a\nsource "$R/runtime-config.sh"\nexport PORT=8443\n'
        'export HV_FRONTEND_ORIGIN="${HV_FRONTEND_ORIGIN:-http://localhost:8081}"\nexport HV_TRUST_PROXY=1\n'
        'export HV_TLS_CERT_PATH="$R/mtls/api/api.crt"\nexport HV_TLS_KEY_PATH="$R/mtls/api/api.key"\n'
        'export HV_TLS_CLIENT_CA_PATH="$R/mtls/api/ca.crt"\nA="$(cat "$R/active-release.txt")"\n'
        'if [ -f "$R/storage-deployment.json" ]; then\n  exec python3 "$A/scripts/storage-runtime-launch.py" --runtime "$R" --role api\nfi\n'
        'cd "$A"\nexec "$R/bin/bun" packages/api/src/server.ts\n',
    "run-worker.sh": PREFIX + 'set -a; source "$R/secrets.env"; set +a\nsource "$R/runtime-config.sh"\nA="$(cat "$R/active-release.txt")"\n'
        'if [ -f "$R/storage-deployment.json" ]; then\n  exec python3 "$A/scripts/storage-runtime-launch.py" --runtime "$R" --role worker --slot "${1:-1}"\nfi\n'
        'cd "$A"\nexec "$R/bin/bun" packages/queue/src/worker.ts\n',
    "run-sweeper.sh": PREFIX + 'source "$R/runtime-config.sh"\nA="$(cat "$R/active-release.txt")"\n'
        'if [ -f "$R/storage-deployment.json" ]; then\n  exec python3 "$A/scripts/storage-runtime-launch.py" --runtime "$R" --role sweeper\nfi\n'
        'cd "$A"\nexec "$R/bin/bun" scripts/sweep-expired.ts\n',
    "run-backup.sh": PREFIX + 'source "$R/runtime-config.sh"\nA="$(cat "$R/active-release.txt")"\n'
        'if [ -f "$R/storage-deployment.json" ]; then\n  exec python3 "$A/scripts/storage-runtime-launch.py" --runtime "$R" --role backup\nfi\n'
        'echo "backup service requires an active storage deployment" >&2\nexit 1\n',
    "run-edge.sh": PREFIX + 'export PORT="${PORT:-8081}"\nexport HV_APP_ROOT="$(cat "$R/active-release.txt")"\n'
        'export HV_EDGE_MTLS_ROOT="$R/mtls/frontend"\nexport HV_EDGE_UPSTREAM="https://127.0.0.1:8443"\n'
        'cd "$R/edge"\nexec "$R/bin/bun" edge.ts\n',
}

# Every paid lane stays mock until an increment declares spend (CLAUDE.md); these are
# the values deploy-private-staging.py writes, repeated so the runtime is complete
# before its first deploy.
RUNTIME_CONFIG = """#!/usr/bin/env bash
export HV_PROVIDER_PRIMARY=mock
export HV_PROVIDER_SECONDARY=mock
export HV_ANIMATIC_PROVIDER=mock
export HV_NARRATION=1
export HV_ANIMATIC_CAPTIONS=0
export HV_MONTHLY_BUDGET_USD=500
export HV_ANIMATIC_COST_CAP_USD=5
export HV_COST_CAP_PER_SHOT_USD=5
export HV_PROVIDER_TIMEOUT_MS=180000
export HV_HTTP_IDLE_TIMEOUT_SECONDS=120
export HV_QUEUE_PATH="$R/data/queue/jobs.json"
export HV_ARTIFACT_ROOT="$R/data/artifacts"
export HV_PROJECT_STATE_PATH="$R/data/state/projects.json"
export HV_COST_LEDGER_PATH="$R/data/state/cost-ledger.json"
export HV_REVIEW_QUEUE_PATH="$R/data/state/operator-review-queue.json"
"""


def systemd_unit(config: Path) -> str:
    return ("[Unit]\nDescription=Rough Cut private staging supervisor\nAfter=network-online.target\n\n"
            f"[Service]\nType=simple\nExecStart=/usr/bin/supervisord -n -c {config}\nRestart=on-failure\nRestartSec=5\n\n"
            "[Install]\nWantedBy=multi-user.target\n")


def parse_env(text: str) -> dict[str, str]:
    """KEY=value lines, optionally `export`ed and shell-quoted; blank lines and comments ignored."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.removeprefix("export ").partition("=")
        if not separator or not key.replace("_", "").isalnum() or not key[0].isalpha():
            raise ValueError("operator secrets file has a line that is not KEY=value")
        parts = shlex.split(value)
        if len(parts) != 1:
            raise ValueError("operator secrets file has a value that is not a single word: " + key)
        values[key] = parts[0]
    return values


def secrets_env(operator: dict[str, str], token_secret: str) -> str:
    lines = ["HV_TOKEN_SECRET=" + shlex.quote(token_secret)]
    lines += [key + "=" + shlex.quote(operator[key]) for key in PROVIDER_KEYS if operator.get(key)]
    return "\n".join(lines) + "\n"

# ---------------------------------------------------------------- effects


class Report:
    def __init__(self) -> None:
        self.created: list[str] = []
        self.kept: list[str] = []


def write_new(path: Path, text: str, mode: int, report: Report) -> None:
    if path.exists():
        report.kept.append(str(path))
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    with os.fdopen(descriptor, "w") as file:
        file.write(text)
    os.chmod(path, mode)
    report.created.append(str(path))


def openssl(*arguments: str) -> None:
    subprocess.run(["openssl", *arguments], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def make_pki(mtls: Path, report: Report) -> None:
    """A private CA, the API's server identity and the edge's client identity, in Zo's layout."""
    ca, api, frontend = mtls / "ca", mtls / "api", mtls / "frontend"
    if (ca / "ca.crt").exists():
        report.kept.append(str(mtls))
        return
    previous = os.umask(0o077)
    try:
        for directory, mode in ((ca, 0o700), (api, 0o755), (frontend, 0o755)):
            directory.mkdir(parents=True, exist_ok=True)
            directory.chmod(mode)
        openssl("req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", "3650", "-keyout", str(ca / "ca.key"),
                "-out", str(ca / "ca.crt"), "-subj", "/CN=Rough Cut Staging mTLS CA")
        for directory, name, usage in ((api, "api", "serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1"),
                                       (frontend, "frontend", "clientAuth")):
            request, extension = directory / (name + ".csr"), directory / (name + ".ext")
            openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", str(directory / (name + ".key")),
                    "-out", str(request), "-subj", "/CN=" + ("localhost" if name == "api" else "rough-cut-edge"))
            extension.write_text("basicConstraints=CA:FALSE\nextendedKeyUsage=" + usage + "\n")
            openssl("x509", "-req", "-in", str(request), "-CA", str(ca / "ca.crt"), "-CAkey", str(ca / "ca.key"), "-CAcreateserial",
                    "-out", str(directory / (name + ".crt")), "-days", "825", "-sha256", "-extfile", str(extension))
            request.unlink()
            extension.unlink()
            shutil.copyfile(ca / "ca.crt", directory / "ca.crt")
            (directory / (name + ".crt")).chmod(0o644)
            (directory / "ca.crt").chmod(0o644)
            (directory / (name + ".key")).chmod(0o600)
    finally:
        os.umask(previous)
    report.created.append(str(mtls))


def install_bun(source: Path, destination: Path, report: Report) -> None:
    if destination.exists():
        report.kept.append(str(destination))
        return
    if source.is_symlink() or not source.is_file():
        raise RuntimeError("--bun must be the verified Bun binary itself, not a link")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(0o755)
    version = subprocess.run([str(destination), "--version"], check=True, capture_output=True, text=True).stdout.strip()
    if version != "1.4.0":
        destination.unlink()
        raise RuntimeError("the pinned runtime is Bun 1.4.0, got " + version)
    report.created.append(str(destination))


def register_programs(config: Path, root: Path, frontend_origin: str, report: Report) -> None:
    current = config.read_text()
    added = [name for name in programs(root, frontend_origin) if f"[program:{name}]" not in current]
    for name, section in programs(root, frontend_origin).items():
        if f"[program:{name}]" in current:
            report.kept.append(f"{config}:[program:{name}]")
    if added:
        with config.open("a") as file:
            file.write("".join(programs(root, frontend_origin)[name] for name in added))
        report.created += [f"{config}:[program:{name}]" for name in added]


def provision(root: Path, platform: Path, config: Path, bun: Path, operator_secrets: Path, frontend_origin: str,
              systemd: bool, report: Report) -> None:
    if not root.is_absolute() or not platform.is_absolute() or not config.is_absolute():
        raise RuntimeError("--root, --platform and --supervisor-config must be absolute paths")
    # Every input is checked before anything is written, so a refusal leaves the host as it was.
    if stat.S_IMODE(operator_secrets.stat().st_mode) & 0o077:
        raise RuntimeError("the operator secrets file must not be readable by group or others")
    operator = parse_env(operator_secrets.read_text())
    if not (root / "bin/bun").exists() and (bun.is_symlink() or not bun.is_file()):
        raise RuntimeError("--bun must be the verified Bun binary itself, not a link")
    for path in (root, platform):
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(0o755)
    # 1. supervisor
    write_new(config, supervisor_base(config), 0o600, report)
    if systemd:
        write_new(Path("/etc/systemd/system/rough-cut-supervisor.service"), systemd_unit(config), 0o644, report)
    # 2. runtime root
    install_bun(bun, root / "bin/bun", report)
    for name in ("data/queue", "data/state", "data/artifacts", "backups", "releases", "logs"):
        (root / name).mkdir(parents=True, exist_ok=True)
    # An empty project state, in the shape ProjectService persists. The API writes it on
    # its first save, but a storage cutover snapshots the JSON source first and needs it.
    write_new(root / "data/state/projects.json", json.dumps(EMPTY_PROJECT_STATE), 0o600, report)
    write_new(root / "edge/edge.ts", (REPO / "infra/staging/edge.ts").read_text(), 0o644, report)
    for name, text in WRAPPERS.items():
        write_new(root / name, text, 0o755 if name == "run-edge.sh" else 0o600, report)
    write_new(root / "runtime-config.sh", RUNTIME_CONFIG, 0o600, report)
    make_pki(root / "mtls", report)
    # 3. secrets: the operator's provider keys by name, a fresh token secret; nothing printed
    write_new(root / "secrets.env", secrets_env(operator, secrets.token_hex(32)), 0o600, report)
    # 4. programs, registered but not started until the first release is installed
    register_programs(config, root, frontend_origin, report)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, required=True, help="staging runtime root, e.g. /srv/rough-cut/staging")
    parser.add_argument("--platform", type=Path, required=True, help="storage platform root, e.g. /srv/rough-cut/storage-platform")
    parser.add_argument("--supervisor-config", type=Path,
                        help="e.g. /etc/rough-cut/supervisord.conf; defaults to HV_SUPERVISOR_CONFIG, which must then be set")
    parser.add_argument("--bun", type=Path, required=True, help="the verified Bun 1.4.0 binary")
    parser.add_argument("--operator-secrets", type=Path, required=True, help="the operator's secrets file, mode 600")
    parser.add_argument("--frontend-origin", default="http://localhost:8081")
    parser.add_argument("--no-systemd", action="store_true")
    arguments = parser.parse_args()
    if arguments.supervisor_config is None and host_config.CONFIG_ENV not in os.environ:
        parser.error("name the new host's supervisor: --supervisor-config, or " + host_config.CONFIG_ENV)
    config = arguments.supervisor_config or host_config.supervisor_config()
    report = Report()
    provision(arguments.root, arguments.platform, config, arguments.bun, arguments.operator_secrets,
              arguments.frontend_origin, not arguments.no_systemd, report)
    print(json.dumps({"created": report.created, "kept": report.kept,
                      "providerKeysCopied": [key for key in PROVIDER_KEYS
                                             if (arguments.root / "secrets.env").exists()
                                             and key + "=" in (arguments.root / "secrets.env").read_text()]}, indent=1))


if __name__ == "__main__":
    main()
