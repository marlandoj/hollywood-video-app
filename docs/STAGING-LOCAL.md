# Private staging on the operator's desktop

**Status:** host ready, cutover pending. Decided by the operator on 2026-09-19 (G10-202609191100); the operator steps below were completed the same day. Zo remains the staging host until the cutover is verified. The build session no longer depends on Zo for anything else: skills and memory come from the operator's Zouroboros VPS.

## Why move

Zo restarted twice in 15 hours, on 2026-09-18 at 18:26 UTC and on 2026-09-19 at 09:40. Prometheus has been down since the first restart (G9). Zo's maintenance tooling also rewrote our supervisor programs, so every deploy since then has silently failed to restore observability. Staging has to be a host whose state we own.

## Shape of the new host

**The host.** One WSL2 Linux distribution on the operator's Windows desktop. Its virtual disk lives on `H:`, so the staging data is physically on that drive while Postgres and the object store run on a native Linux filesystem inside it.

Do not run Postgres directly on `/mnt/h`. Windows-mounted paths are slow, and Postgres refuses data directories whose permissions it cannot set.

**The topology is the same as Zo's:**
- one supervisord config;
- PostgreSQL 15 and RustFS, pinned by the existing bootstrap;
- the API, three workers, the sweeper, the backup job and the mTLS edge;
- the observability trio.

The scripts that start it are the ones already in the repository, once their Zo-specific paths are parameterized (Release 1 build step 1). The base image is Debian. Zo runs Debian 12, and the pinned Postgres packages are Debian 12 builds.

**Layout on `H:`:**

```
H:\Claude\Rough-Cut-Staging\
  wsl\        the distribution's virtual disk (ext4.vhdx): Postgres, objects, releases
  inbox\      file drop between the build session and the host (replaces the repo clone's .claude-inbox)
  archives\   portable project archives (HV-040) exported from Zo and from the new host
  backups\    copies of the host's encrypted backups. Same machine, so not off-host
  evidence\   collector output before it is committed
  secrets\    nothing is read from here automatically; see the GitHub section
  runbooks\   this procedure and the recovery notes
```

`H:\Claude\Hollywood-Video-App` is a git working copy and stays one. Nothing for staging goes inside it.

## What changes compared with Zo

| | Zo | Desktop |
|---|---|---|
| Availability | Whenever Zo is up | **Only while the desktop is on and awake.** Sleep and hibernate must be off for the hours staging should answer |
| Who owns the supervisor config | Zo's maintenance tooling, too | Only this repository's scripts |
| Reviewer access | Operator tailnet, mTLS edge | The same, if Tailscale runs on the desktop. Without it, reviewers must be on the desktop itself |
| Push route from the build session | Bundle → Windows → `scp` to Zo → push (four hops) | Bundle → `H:` inbox → the host fetches it from `/mnt/h` and pushes with its own token (two hops). Direct once the build session's git proxy admits the repository |
| Secrets | Zo Secrets | A root-only env file inside the distribution, entered by the operator |

## Operator steps (completed 2026-09-19)

The operator ran these as double-click scripts from `H:\Claude\Rough-Cut-Staging\runbooks\scripts\`, each logging to `runbooks\logs\`. No key or token passed through chat or through a file on `H:`. What was actually done, where it differs from the first plan:

1. **Distribution.** `wsl --install -d Debian` now installs Debian 13, which the pinned PostgreSQL 15 packages do not support, and `wsl --update` fails on this machine (error 1603, low space on `C:`). The host is instead the linuxcontainers.org **Debian 12 (bookworm) amd64** root filesystem, SHA256-checked, imported with `wsl --import rough-cut-staging H:\Claude\Rough-Cut-Staging\wsl` (`01-setup`).
2. **systemd and SSH** (`01-inside.sh`). `/etc/wsl.conf` sets `systemd=true`, `default=root`, `appendWindowsPath=false`. The container image needed fixes a stock WSL image does not: `systemd-firstboot` and the console getty masked (boot hung waiting for input), machine-id, UTC and `C.UTF-8` set, `systemd-networkd`/`systemd-resolved` masked (they fight WSL's networking), and `ssh.socket` masked so `ssh.service` listens on **2222 only**. Key-only: `PasswordAuthentication no`, `PermitRootLogin prohibit-password`; the operator's Windows public keys are authorized.
3. **Networking.** Mirrored mode broke DNS inside the distribution while the operator's VPN was up, so WSL uses **NAT** (`06-nat`). `localhost:2222` from Windows still reaches the host. `.wslconfig` is `[wsl2]` + `vmIdleTimeout=-1`; the previous files are kept as `.wslconfig.bak-*`.
4. **Keep-alive.** Scheduled task "Rough Cut staging" runs `conhost --headless wsl.exe -d rough-cut-staging -u root -- sleep infinity` at logon. Power sleep is off.
5. **Provider keys** (`08-set-secrets`). The operator entered `FAL_KEY` and `HV_AZURE_SPEECH_KEY` (Speech resource in East US) at a masked prompt; they are in `/root/.config/rough-cut/secrets.env`, mode 600. `07-check-secrets` prints names and lengths only. `HV_TOKEN_SECRET` is generated per host at deploy.
6. **Build-session access** (`11-add-connectors`). Two connectors in the Claude desktop app, `rough-cut-staging` (`root@localhost:2222`) and `zouroboros-vps`, run `ssh-host.cjs` with the aliases in `%UserProfile%\.ssh\rough-cut-config` (key-only, `BatchMode`). They replace the `zo-computer` connector for staging work.
7. **GitHub** (`12-github-token`). A fine-grained token for `marlandoj/hollywood-video-app` only: Contents and Pull requests read/write; Actions, Commit statuses and Metadata read; **no Workflows, no Administration**; 90 days. It lives only in root's `gh` config on the host (mode 600). Fine-grained tokens cannot read check runs through GraphQL, so CI status is read through the Actions API (`/actions/runs?head_sha=…`), not `gh pr checks`.

The host: Debian 12.15, 8 CPUs, 31 GB memory, a 1 TB virtual disk on `H:`. The repository is cloned at `/root/src/hollywood-video-app`.

## Build-session steps (after the operator steps)

1. **Parameterize the host paths.** HV-032-03: `HV_SUPERVISOR_CONFIG` and `HV_SUPERVISOR_RPC_URL` (`docs/STORAGE-BOOTSTRAP.md`, "Which supervisor"), Zo's values as defaults.
2. **Provision the host.** Install Python, supervisord, ffmpeg and the pinned Bun 1.4.0. Give supervisord its own configuration with an XML-RPC listener on loopback, and export both variables for every script. Run `bootstrap-storage-platform.py`, which installs the pinned Postgres 15 and RustFS and generates **fresh** database, object-store and TLS credentials. None of Zo's are reused.
3. **Deploy the current `main`** with `deploy-storage-staging.py` and wait for `{"phase": "healthy"}`.
4. **Carry the data across as archives, not as a database copy.** Export Zo's projects as portable archives into `archives\` and import them on the new host. This also exercises HV-040's archive path on a real move. Staging data is test data, so an empty start is acceptable if an archive refuses.
5. **Re-record the evidence** (`wave-a-exit.json`, `observability-exit.json`) on the new host. Observability must come back `instrumented: true` before HV-038's claim is restored.
6. **Point the loop at the new host.** Update `scripts/loop/loop.env`, `CLAUDE.md`, `STORAGE-DEPLOYMENT.md` and this file, and record the cutover.
7. **Keep Zo's staging stopped but intact for one week as a fallback,** then ask the operator before removing it (a G8-class decision).

## Risks

- **The desktop is a single machine.** Backups copied to `H:\…\backups` are on the same disk. Off-host recovery remains the open HV-038 item it already was, and needs a destination (G3).
- **Uptime is tied to the desktop.** A reboot for Windows Update stops staging until logon. The scheduled task brings it back, but only after a logon.
- **Reviewer reach.** Without Tailscale on the desktop, a reviewer on another device cannot reach staging, and Release 1's exit criterion 2 depends on that.
