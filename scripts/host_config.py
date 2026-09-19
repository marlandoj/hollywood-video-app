"""Where the staging host keeps the supervisor these scripts register programs with.

Every staging script used to name Zo's user supervisor directly, in seven places.
This module is the one place that knows it. A host that runs its own supervisor sets
HV_SUPERVISOR_CONFIG (and HV_SUPERVISOR_RPC_URL if its XML-RPC endpoint differs);
unset, both keep Zo's values, so nothing changes on Zo.

The TypeScript collectors read the same variable through scripts/host-config.ts, which
must agree with the defaults below (packages/storage/test/host-config.test.ts).
"""
import os
from pathlib import Path
from urllib.parse import urlsplit

CONFIG_ENV = "HV_SUPERVISOR_CONFIG"
RPC_ENV = "HV_SUPERVISOR_RPC_URL"
ZO_SUPERVISOR_CONFIG = "/etc/zo/supervisord-user.conf"
ZO_SUPERVISOR_RPC_URL = "http://127.0.0.1:29011/RPC2"


def supervisor_config(environ=os.environ) -> Path:
    """The supervisord configuration file. Absolute, or refused: a relative path would
    resolve against whatever directory a wrapper happened to start in."""
    if CONFIG_ENV not in environ:
        return Path(ZO_SUPERVISOR_CONFIG)
    value = environ[CONFIG_ENV]
    if not value or not os.path.isabs(value) or value != value.strip():
        raise ValueError(f"{CONFIG_ENV} must be an absolute path, got {value!r}")
    return Path(value)


def supervisor_rpc_url(environ=os.environ) -> str:
    """The supervisor's XML-RPC endpoint. Loopback only: these scripts start and stop
    the studio's services, and must never do that to another machine."""
    if RPC_ENV not in environ:
        return ZO_SUPERVISOR_RPC_URL
    value = environ[RPC_ENV]
    parts = urlsplit(value)
    if parts.scheme != "http" or parts.hostname not in ("127.0.0.1", "localhost", "::1") or not parts.port:
        raise ValueError(f"{RPC_ENV} must be a loopback http URL with a port, got {value!r}")
    return value


# Debian keeps useradd and runuser in /usr/sbin; Zo's image did not, so a PATH without
# the sbin directories worked there and fails on a stock host.
SERVICE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def child_environment(environ=os.environ) -> dict:
    """A minimal environment for a helper that registers supervisor programs: the service
    PATH, plus the two supervisor settings when the host sets them. Without them the child
    falls back to Zo's supervisor, which does not exist on any other host."""
    return {"PATH": SERVICE_PATH, **{key: environ[key] for key in (CONFIG_ENV, RPC_ENV) if key in environ}}
