#!/usr/bin/env python3
"""Install checksum-pinned official observability binaries; does not start services."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import platform
import tarfile
import urllib.request
import uuid

RELEASES = [
    {"name": "jaeger", "version": "2.20.0", "bytes": 58367331,
     "url": "https://github.com/jaegertracing/jaeger/releases/download/v2.20.0/jaeger-2.20.0-linux-amd64.tar.gz",
     "sha256": "c967368ba09be356089ef7e8aab2a76d170dc007ff6ccf7925c8167ede2900d7",
     "members": {"jaeger": "jaeger-2.20.0-linux-amd64/jaeger"}},
    {"name": "otelcol-contrib", "version": "0.160.0", "bytes": 110294081,
     "url": "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.160.0/otelcol-contrib_0.160.0_linux_amd64.tar.gz",
     "sha256": "7bb60c584c241c86261c2b8697cd3725dd8c56691f5ad5d98454eaa005b47b0c",
     "members": {"otelcol-contrib": "otelcol-contrib"}},
    {"name": "prometheus", "version": "3.14.0", "bytes": 107111714,
     "url": "https://github.com/prometheus/prometheus/releases/download/v3.14.0/prometheus-3.14.0.linux-amd64.tar.gz",
     "sha256": "f665c6da19eb7ba399c915d30c7d9793c9b417bf8a749b504bc470678631478d",
     "members": {"prometheus": "prometheus-3.14.0.linux-amd64/prometheus", "promtool": "prometheus-3.14.0.linux-amd64/promtool"}},
]


def digest(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("runtime payload is not a regular file")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def directory(path):
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        raise RuntimeError("runtime directory is unsafe")
    path.mkdir(parents=True, exist_ok=True, mode=0o755)


def install(root, release):
    archive = root / "downloads" / (release["sha256"] + ".tar.gz")
    if not archive.exists():
        pending = archive.with_name(archive.name + "." + str(uuid.uuid4()) + ".pending")
        received = 0
        with urllib.request.urlopen(release["url"], timeout=60) as response, pending.open("xb") as output:
            while block := response.read(2 * 1024 ** 2):
                received += len(block)
                if received > release["bytes"]:
                    raise RuntimeError("release archive exceeds its pinned size")
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
        if received != release["bytes"] or digest(pending) != release["sha256"]:
            raise RuntimeError("release archive failed checksum verification")
        os.replace(pending, archive)
    if archive.stat().st_size != release["bytes"] or digest(archive) != release["sha256"]:
        raise RuntimeError("cached release archive failed checksum verification")
    binaries = {}
    with tarfile.open(archive, "r:gz") as package:
        members = package.getmembers()
        for name, member_path in release["members"].items():
            matches = [member for member in members if member.name == member_path]
            if len(matches) != 1 or not matches[0].isfile() or not 0 < matches[0].size < 700 * 1024 ** 2:
                raise RuntimeError("release does not contain the expected regular executable")
            target = root / "bin" / (name + "-" + release["version"])
            pending = target.with_name(target.name + "." + str(uuid.uuid4()) + ".pending")
            source = package.extractfile(matches[0])
            if source is None:
                raise RuntimeError("executable payload is unavailable")
            with source, pending.open("xb") as output:
                while block := source.read(2 * 1024 ** 2):
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
            checksum = digest(pending)
            if target.exists() or target.is_symlink():
                if digest(target) != checksum:
                    raise RuntimeError("installed executable differs from its pinned release")
                pending.unlink()
            else:
                pending.chmod(0o755)
                os.replace(pending, target)
            binaries[name] = {"path": str(target), "sha256": checksum, "bytes": target.stat().st_size}
    return {"name": release["name"], "version": release["version"], "sourceUrl": release["url"], "archiveSha256": release["sha256"], "binaries": binaries}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("pinned binaries require Linux x86_64")
    if not args.root.is_absolute() or args.root.is_symlink():
        raise RuntimeError("choose an absolute regular runtime directory")
    root = args.root.resolve()
    directory(root)
    for name in ("bin", "downloads"):
        directory(root / name)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        releases = list(pool.map(lambda release: install(root, release), RELEASES))
    manifest = {"schema": "hv-observability-binaries/1", "root": str(root), "releases": releases}
    temporary = root / ("binaries." + str(uuid.uuid4()) + ".pending")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, "w") as output:
        json.dump(manifest, output, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, root / "binaries.json")
    for path in (root / "downloads", root / "bin", root):
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    print(json.dumps({"installed": True, "servicesStarted": False, "versions": {value["name"]: value["version"] for value in releases}}))


if __name__ == "__main__":
    main()
