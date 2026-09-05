# Restarting the private storage platform

Zo has repeatedly preserved workspace data while reverting newly added service
registrations under `/etc/zo`. The storage bootstrap restores only the two Rough
Cut storage registrations from the existing runtime. It does not initialize a
database, generate new credentials, change application storage selection, or
replace unrelated supervisor configuration.

```sh
python3 scripts/bootstrap-storage-platform.py --root /home/workspace/.runtime/rough-cut-storage-platform
```

The runtime must already contain PostgreSQL 15 data, the verified database and
object-store distributions, startup scripts, and existing TLS identities and
credentials. Missing data or identity files cause startup to fail. A lock
serializes concurrent callers. Existing service names with a different command
are rejected. Configuration publication preserves unrelated sections and file
permissions; the bootstrap starts only the two storage programs and verifies
the database over mTLS and the object-store health endpoint over TLS.

PostgreSQL may need several minutes to recover after an unclean Zo reset. The
readiness deadline allows ten minutes; it never weakens fsync, checksums, TLS or
authentication to accelerate recovery. Startup scripts recreate their fixed
non-login service accounts when those accounts were lost by the reset.

The controlled drill gracefully stopped the evaluation storage services, removed
their registrations, then restored both through bootstrap. Data and TLS
identities survived. The restored project capability, MP4 ranges, captions and
HLS passed afterward, and live JSON/local staging remained healthy throughout.
Configuration tests cover preservation of unrelated services, idempotency,
conflicting names and refusal to initialize missing data. Evidence is recorded
in `docs/evidence/hv040-storage/service-bootstrap.json`.

This drill did not reboot the Zo host. During the PostgreSQL/S3 staging cutover,
wire this bootstrap into the existing managed API startup using the immutable
application release and existing private runtime. That registered API service
provides the restart entrypoint after a Zo reset. Automatic startup wiring and
an actual host-reset drill remain pending; do not claim restart persistence
based solely on this controlled registration test.

An unplanned Zo restart subsequently removed both registrations and reverted the
working checkout. The pushed commit was restored from GitHub, and a manual
bootstrap invocation restarted the existing storage services. PostgreSQL's cold
recovery exposed a single-probe timeout; readiness now retries those timeouts
within its ten-minute deadline. Four Python tests pass, and the original project
capability and media delivery passed after recovery. This is additional evidence
of manual recovery after a real reset, not automatic startup wiring. See
`docs/evidence/hv040-storage/reset-recovery.json`.
