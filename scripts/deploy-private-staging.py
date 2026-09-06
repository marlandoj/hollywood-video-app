#!/usr/bin/env python3
"""Deploy a verified commit to the existing private Zo staging services."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

SERVICES = ["rough-cut-staging-edge", "rough-cut-staging-api", "rough-cut-staging-worker", "rough-cut-staging-sweeper"]
def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)
def supervisor(action):
    run("supervisorctl", "-c", "/etc/zo/supervisord-user.conf", action, *SERVICES)
def idle(root):
    path = root / "data/queue/jobs.json"
    jobs = json.loads(path.read_text()) if path.exists() else []
    if any(j["status"] in ("running", "queued") for j in jobs):
        raise RuntimeError("staging still has active jobs; drain it before deployment")
def require_json_backend(root):
    if (root / "storage-json-current.json").exists():
        raise RuntimeError("use the storage release workflow for exported JSON staging; legacy paths could hide newer data")
    marker = root / "storage-deployment.json"
    if marker.exists() and json.loads(marker.read_text()).get("backend") == "postgres":
        raise RuntimeError("use the storage deployment workflow for PostgreSQL staging; a JSON deploy could hide newer data")

def prepare_release(root, repo, sha):
    if root != root.resolve() or not root.is_dir() or not (root / "secrets.env").is_file():
        raise RuntimeError("root must be an existing, resolved private staging runtime")
    fullsha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", sha + "^{commit}"], text=True).strip()
    run("git", "-C", str(repo), "merge-base", "--is-ancestor", fullsha, "origin/main")
    for binary in ("ffmpeg", "ffprobe", "espeak-ng", "supervisorctl"):
        if not shutil.which(binary): raise RuntimeError(binary + " is required")
    release = root / "releases" / (fullsha + "-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S"))
    release.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryFile() as archive:
        run("git", "-C", str(repo), "archive", fullsha, stdout=archive)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as tar:
            # Repository contents only; reject traversal and external symlinks.
            for member in tar.getmembers():
                if member.name.startswith("/") or ".." in Path(member.name).parts or member.issym() or member.islnk():
                    raise RuntimeError("unsafe release archive member")
            tar.extractall(release)
    run(str(root / "bin/bun"), "install", "--frozen-lockfile", cwd=release)
    (release / ".deployed-sha").write_text(fullsha + "\n")
    return release, fullsha

def install(root, repo, sha):
    require_json_backend(root)
    idle(root)
    release, fullsha = prepare_release(root, repo, sha)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = root / "backups" / stamp
    backup.mkdir(parents=True, mode=0o700)
    scripts = ["run-api.sh", "run-worker.sh", "run-edge.sh", "run-sweeper.sh", "runtime-config.sh"]
    for name in scripts:
        if (root / name).exists(): shutil.copy2(root / name, backup / name)
    try:
        supervisor("stop")
        idle(root)  # close the admission/stop race before changing any state
        for name in ("queue", "state"):
            if (root / "data" / name).exists(): shutil.copytree(root / "data" / name, backup / name)
        active = root / "active-release.txt"
        old_app = active.read_text().strip() if active.exists() else str(root / "app")
        (backup / "previous-app-path.txt").write_text(old_app + "\n")
        temporary = root / "active-release.tmp"
        temporary.write_text(str(release) + "\n")
        os.replace(temporary, active)
        common = """#!/usr/bin/env bash
export HV_PROVIDER_PRIMARY=mock
export HV_PROVIDER_SECONDARY=mock
export HV_ANIMATIC_PROVIDER=mock
export HV_NARRATION=1
export HV_ANIMATIC_CAPTIONS=0
export HV_MONTHLY_BUDGET_USD=500
export HV_ANIMATIC_COST_CAP_USD=5
export HV_COST_CAP_PER_SHOT_USD=5
export HV_PROVIDER_TIMEOUT_MS=180000
export HV_QUEUE_PATH="$R/data/queue/jobs.json"
export HV_ARTIFACT_ROOT="$R/data/artifacts"
export HV_PROJECT_STATE_PATH="$R/data/state/projects.json"
export HV_COST_LEDGER_PATH="$R/data/state/cost-ledger.json"
export HV_REVIEW_QUEUE_PATH="$R/data/state/operator-review-queue.json"
"""
        (root / "runtime-config.sh").write_text(common)
        api = (backup / "run-api.sh").read_text()
        # The shared provider configuration must be sourced last: API admission and worker execution agree.
        api = api.replace('cd "$R/app"', 'source "$R/runtime-config.sh"\ncd "$(cat "$R/active-release.txt")"')

        (root / "run-api.sh").write_text(api)
        worker = """#!/usr/bin/env bash
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
set -a; source "$R/secrets.env"; set +a
source "$R/runtime-config.sh"
export HV_WORKER_ID="zo-staging-worker-$$"
cd "$(cat "$R/active-release.txt")"
exec "$R/bin/bun" packages/queue/src/worker.ts
"""
        (root / "run-worker.sh").write_text(worker)
        edge = (backup / "run-edge.sh").read_text().replace('export HV_APP_ROOT="$R/app"', 'export HV_APP_ROOT="$(cat "$R/active-release.txt")"')
        (root / "run-edge.sh").write_text(edge)
        sweeper = (backup / "run-sweeper.sh").read_text().replace('cd "$R/app"', 'cd "$(cat "$R/active-release.txt")"')
        (root / "run-sweeper.sh").write_text(sweeper)
        supervisor("start")
        with urllib.request.urlopen("http://127.0.0.1:8081/health", timeout=15) as response:
            if response.status != 200: raise RuntimeError("health check failed")
        print(json.dumps({"deployed": fullsha, "backup": str(backup), "privateOnly": True, "providers": "mock", "narration": True}))
    except BaseException:
        if (backup / "previous-app-path.txt").exists():
            rollback(root, backup)
        else:
            supervisor("start")
        raise

def rollback(root, backup):
    require_json_backend(root)
    if backup.resolve().parent != (root / "backups").resolve(): raise RuntimeError("backup outside runtime")
    idle(root)
    supervisor("stop")
    try:
        idle(root)
        ledger = root / "data/state/cost-ledger.json"
        if ledger.exists():
            state = json.loads(ledger.read_text())
            if isinstance(state, dict):
                # Keep every billed event; an older binary only understands the legacy array.
                shutil.copy2(ledger, backup / "pre-rollback-ledger-v2.json")
                temporary = ledger.with_suffix(".rollback.tmp")
                temporary.write_text(json.dumps(state["events"]))
                os.replace(temporary, ledger)
        (root / "active-release.txt").write_text((backup / "previous-app-path.txt").read_text())
        for name in ("run-api.sh", "run-worker.sh", "run-edge.sh", "run-sweeper.sh", "runtime-config.sh"):
            if (backup / name).exists(): shutil.copy2(backup / name, root / name)
        print("Restored prior code and startup configuration; project data and charges retained.")
    finally:
        supervisor("start")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--sha")
    parser.add_argument("--rollback", type=Path)
    args = parser.parse_args()
    if args.rollback: rollback(args.root.resolve(), args.rollback)
    else:
        if not args.repo or not args.sha: parser.error("--repo and --sha are required")
        install(args.root.resolve(), args.repo.resolve(), args.sha)
