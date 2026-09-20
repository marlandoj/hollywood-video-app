#!/usr/bin/env python3
"""Choose which generation providers private staging uses (HV-019-05).

A profile is one of a fixed table, never free text: `mock` (the default every deploy writes),
`live-storyboards` (fal FLUX Schnell stills for the rough cut, finals stay mock), `live-film`
(fal stills and fal Kling video for finals) and `live-film-anchored` (finals start from the approved
storyboard still with Kling O3 keyframes; Kling 2.5 for any shot without a pinned still). Only the provider lines of runtime-config.sh change;
every cap (monthly, per shot, per film) is left exactly as it is. A live profile is refused unless
the operator has entered FAL_KEY in the runtime secrets file. The key's value is never read into
the configuration or printed. The API and the workers are then restarted; a worker finishes its
current job before it stops. A cutover or rollback writes mock again.

Usage: staging-providers.py --root $RC_RUNTIME [--profile live-storyboards] [--voice azure|off] [--no-restart]

`--voice azure` (HV-022-03) points the studio at the operator's Azure voice catalogue,
$RC_RUNTIME/audio-policies.json, written by scripts/audio-policy.ts; `--voice off` removes it.
"""
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess

PROVIDER_KEYS = ("HV_ANIMATIC_PROVIDER", "HV_PROVIDER_PRIMARY", "HV_PROVIDER_SECONDARY")
# A pool setting overrides the three above; profiles never set one, so any is removed.
POOL_KEYS = ("HV_PROVIDER_POOL", "HV_ANIMATIC_PROVIDER_POOL")
FAL_IMAGE = "image:fal:flux-schnell"
FAL_VIDEO = "fal:kling-v2.5-turbo-pro"
# HV-017-07: first-frame video, so the final starts from the approved storyboard still (HV-017-06).
FAL_KEYFRAMES = "fal:kling-o3-standard-keyframes"
PROFILES = {
    "mock": {"HV_ANIMATIC_PROVIDER": "mock", "HV_PROVIDER_PRIMARY": "mock", "HV_PROVIDER_SECONDARY": "mock"},
    "live-storyboards": {"HV_ANIMATIC_PROVIDER": FAL_IMAGE, "HV_PROVIDER_PRIMARY": "mock", "HV_PROVIDER_SECONDARY": "mock"},
    "live-film": {"HV_ANIMATIC_PROVIDER": FAL_IMAGE, "HV_PROVIDER_PRIMARY": FAL_VIDEO, "HV_PROVIDER_SECONDARY": FAL_VIDEO},
    "live-film-anchored": {"HV_ANIMATIC_PROVIDER": FAL_IMAGE, "HV_PROVIDER_PRIMARY": FAL_KEYFRAMES, "HV_PROVIDER_SECONDARY": FAL_VIDEO},
}
EXPORT = re.compile(r"^export ([A-Z][A-Z0-9_]*)=(.*)$")


def render(text, profile):
    """The runtime configuration with only its provider lines changed to the profile's."""
    if profile not in PROFILES: raise ValueError("unknown provider profile")
    wanted = PROFILES[profile]; seen = set(); lines = []
    for line in text.splitlines():
        match = EXPORT.match(line)
        key = match.group(1) if match else None
        if key in POOL_KEYS: continue
        if key in wanted:
            if key in seen: continue
            seen.add(key); lines.append("export " + key + "=" + shlex.quote(wanted[key])); continue
        lines.append(line)
    lines += ["export " + key + "=" + shlex.quote(wanted[key]) for key in PROVIDER_KEYS if key not in seen]
    return "\n".join(lines) + "\n"


def current_profile(text):
    values = {}
    for line in text.splitlines():
        match = EXPORT.match(line)
        if match and match.group(1) in POOL_KEYS: return "custom"
        if match and match.group(1) in PROVIDER_KEYS: values[match.group(1)] = shlex.split(match.group(2))[0] if match.group(2) else ""
    return next((name for name, table in PROFILES.items() if table == values), "custom")


def has_fal_key(secrets):
    """Whether the operator entered a FAL_KEY. Only its presence is checked; the value is not kept."""
    for line in secrets.read_text().splitlines():
        if line.startswith("FAL_KEY="):
            value = line.split("=", 1)[1].strip()
            return len(shlex.split(value)[0] if value else "") >= 16
    return False


def private_write(path, text):
    temporary = path.with_name(path.name + ".pending")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as file: file.write(text); file.flush(); os.fsync(file.fileno())
    os.replace(temporary, path)


def restart(names):
    spec = importlib.util.spec_from_file_location("host_config", Path(__file__).with_name("host_config.py"))
    host_config = importlib.util.module_from_spec(spec); spec.loader.exec_module(host_config)
    config = host_config.supervisor_config()
    for name in names:
        result = subprocess.run(["supervisorctl", "-c", str(config), "restart", name], capture_output=True, timeout=1200)
        if result.returncode: raise RuntimeError("restart failed: " + name)


def apply(root, profile, now=None):
    config, secrets = root / "runtime-config.sh", root / "secrets.env"
    if profile not in PROFILES: raise ValueError("unknown provider profile")
    if profile != "mock" and not has_fal_key(secrets): raise RuntimeError("A live profile needs FAL_KEY in the runtime secrets; the operator enters it.")
    before = config.read_text(); previous = current_profile(before)
    private_write(config, render(before, profile))
    record = {"schema": "hv-provider-profile/1", "profile": profile, "previous": previous, "providers": PROFILES[profile],
              "at": (now or datetime.datetime.now(datetime.timezone.utc)).isoformat()}
    private_write(root / "provider-profile.json", json.dumps(record, indent=2) + "\n")
    return record


VOICE_KEY = "HV_AUDIO_POLICY_FILE"


def has_secret(secrets, name):
    """Whether the operator entered NAME. Only its presence is checked; the value is not kept."""
    for line in secrets.read_text().splitlines():
        if line.startswith(name + "="):
            value = line.split("=", 1)[1].strip()
            return len(shlex.split(value)[0] if value else "") >= 16
    return False


def render_voice(text, policy_path):
    """HV-022-03: the configuration with only the voice catalogue line set (a path) or removed (None)."""
    lines = [line for line in text.splitlines() if not (EXPORT.match(line) and EXPORT.match(line).group(1) == VOICE_KEY)]
    if policy_path is not None: lines.append("export " + VOICE_KEY + "=" + shlex.quote(str(policy_path)))
    return "\n".join(lines) + "\n"


def apply_voice(root, mode, now=None):
    """`azure` points the studio at the operator's catalogue (audio-policies.json in the runtime root); `off` removes it."""
    config, secrets, catalogue = root / "runtime-config.sh", root / "secrets.env", root / "audio-policies.json"
    if mode not in ("azure", "off"): raise ValueError("unknown voice setting")
    if mode == "azure":
        if not has_secret(secrets, "HV_AZURE_SPEECH_KEY"): raise RuntimeError("Azure voices need HV_AZURE_SPEECH_KEY in the runtime secrets; the operator enters it.")
        try: value = json.loads(catalogue.read_text())
        except (OSError, ValueError): raise RuntimeError("Write the voice catalogue first (scripts/audio-policy.ts).")
        if value.get("schema") != "hv-audio-policies/1" or not value.get("policies"): raise RuntimeError("The voice catalogue is not usable.")
        if catalogue.stat().st_mode & 0o077: raise RuntimeError("The voice catalogue must be private (mode 600).")
    private_write(config, render_voice(config.read_text(), catalogue if mode == "azure" else None))
    record_path = root / "provider-profile.json"
    try: record = json.loads(record_path.read_text())
    except (OSError, ValueError): record = {"schema": "hv-provider-profile/1", "profile": current_profile(config.read_text())}
    record.update({"voice": mode, "voiceAt": (now or datetime.datetime.now(datetime.timezone.utc)).isoformat()})
    private_write(record_path, json.dumps(record, indent=2) + "\n")
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--profile", choices=sorted(PROFILES))
    parser.add_argument("--voice", choices=["azure", "off"])
    parser.add_argument("--no-restart", action="store_true")
    args = parser.parse_args()
    if not args.profile and not args.voice: parser.error("choose --profile, --voice or both")
    root = args.root.resolve(strict=True)
    if args.voice == "azure":
        # The application's own validator checks every hash before the studio is pointed at it.
        release = Path((root / "active-release.txt").read_text().strip())
        checked = subprocess.run([str(root / "bin/bun"), "scripts/audio-policy.ts", "--check", str(root / "audio-policies.json")], cwd=release, capture_output=True, timeout=120)
        if checked.returncode: raise RuntimeError("The voice catalogue failed its check: " + checked.stdout.decode()[-300:] + checked.stderr.decode()[-300:])
    record = apply(root, args.profile) if args.profile else {}
    if args.voice: record = apply_voice(root, args.voice)
    if not args.no_restart:
        restart(["rough-cut-staging-api", "rough-cut-staging-worker", "rough-cut-staging-worker-2", "rough-cut-staging-worker-3"])
    print(json.dumps(record))


if __name__ == "__main__":
    main()
