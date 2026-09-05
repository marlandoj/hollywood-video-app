#!/usr/bin/env python3
"""Hold a repository lock until the parent closes stdin."""
import argparse
import fcntl
import os
from pathlib import Path
import sys
import signal

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root",type=Path,required=True)
parser.add_argument("--shared",action="store_true")
args=parser.parse_args()
root=args.root.resolve(strict=True)
path=root/"repository.lock"
flags=(os.O_RDONLY if args.shared and path.exists() else os.O_RDWR|os.O_CREAT)|os.O_NOFOLLOW
descriptor=os.open(path,flags,0o600)
try:
    fcntl.flock(descriptor,fcntl.LOCK_SH if args.shared else fcntl.LOCK_EX)
    # Group termination must not release the lock while the parent drains.
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    signal.signal(signal.SIGINT,signal.SIG_IGN)
    sys.stdout.write("locked\n");sys.stdout.flush()
    while sys.stdin.buffer.read(8192):pass
finally:os.close(descriptor)
