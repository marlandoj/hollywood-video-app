#!/usr/bin/env python3
"""Stage private observability settings for the next managed API/worker start."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runtime',type=Path,required=True)
group=parser.add_mutually_exclusive_group(required=True)
group.add_argument('--enable',action='store_true');group.add_argument('--disable',action='store_true')
args=parser.parse_args()
root=args.runtime.resolve(strict=True)
spec=importlib.util.spec_from_file_location('storage_runtime',Path(__file__).with_name('storage-runtime-launch.py'))
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)
runtime.deployment(root)
key=root/'operator-diagnostics.secret'
if not key.exists():
    descriptor=os.open(key,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'w') as file:file.write(secrets.token_hex(32)+'\n');file.flush();os.fsync(file.fileno())
else:runtime.regular(key,True)
runtime.private_json(root/'observability.json',{'schema':'hv-observability-settings/1','enabled':args.enable,'root':str(root.parent/'rough-cut-observability')})
print(json.dumps({'settingsStaged':True,'telemetryEnabledOnNextStart':args.enable,'operatorAccess':'separate short-lived read-only capability','runningProcessesChanged':False}))
