# Private staging on the operator's desktop

**Status:** cut over on 2026-09-19 (HV-032-04). Private staging now runs on the operator's desktop, on PostgreSQL + S3 with three workers and the observability trio. Decided by the operator on 2026-09-19 (G10-202609191100); the operator steps below were completed the same day. Zo's staging is left running and untouched as the fallback for a week, then its removal goes back to the operator. The build session no longer depends on Zo for anything else: skills and memory come from the operator's Zouroboros VPS.

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

## Build-session steps (completed 2026-09-19)

Everything below ran on the host through the `rough-cut-staging` connector, from the repository, with no file copied from Zo. The layout:

| Path | What |
|---|---|
| `/etc/rough-cut/supervisord.conf` | the host's own supervisor (XML-RPC on `127.0.0.1:29011`), run by `rough-cut-supervisor.service`; Debian's `supervisor.service` is disabled |
| `/etc/rough-cut/host.env` | `HV_SUPERVISOR_CONFIG`, `HV_SUPERVISOR_RPC_URL`, `RC_RUNTIME`, `RC_PLATFORM`; source it before running any staging script by hand |
| `/srv/rough-cut/staging` | the runtime root (`LOOP_STAGING_ROOT`) |
| `/srv/rough-cut/storage-platform` | PostgreSQL 15.19 and RustFS 1.0.0-rc.5, their data, PKI and role files |
| `/srv/rough-cut/rough-cut-observability` | Jaeger, the OpenTelemetry collector and Prometheus |
| `/root/src/hollywood-video-app` | the checkout releases are cut from |

1. **Packages.** `python3 supervisor ffmpeg espeak-ng fonts-dejavu-core openssl unzip xz-utils python3-boto3`, and PostgreSQL's runtime libraries.
2. **Pinned binaries, checked byte for byte.** `postgresql-15`, `postgresql-client-15` and `libpq5` at `15.19-0+deb12u1` from the Debian archive, and the RustFS `1.0.0-rc.5` zip from its GitHub release. Their SHA-256 equal the files Zo installed from. Bun 1.4.0's `bun-linux-x64.zip` passed its release's `SHASUMS256.txt`, and the binary's SHA-256 equals Zo's `bin/bun`.
3. **Provision** (`scripts/provision-staging-host.py`, new in HV-032-04):
   - the supervisor and its systemd unit;
   - the runtime root, from `infra/staging/edge.ts`;
   - the startup wrappers and the mock-only runtime configuration;
   - a private mTLS CA with the API's server identity and the edge's client identity;
   - `secrets.env`, with a fresh `HV_TOKEN_SECRET` plus `FAL_KEY` and `HV_AZURE_SPEECH_KEY` copied by name from the operator's file;
   - the four application programs.
4. **First release (JSON):** `deploy-private-staging.py --sha <main>`, healthy.
5. **Storage platform:** `prepare-postgres.py`, `prepare-object-storage.py`, `prepare-database-tls.py`. These generate fresh database, object-store and TLS credentials, and none of Zo's are reused.
6. **Cutover:** `deploy-storage-staging.py --platform … --database hollywood_video_staging_desktop --bucket rough-cut-staging-desktop` → `{"phase": "healthy", "backend": "postgres"}`. Nine programs are `RUNNING`, three of them workers. A mock animatic job ran to `done` through the edge.
   - Two earlier attempts stopped before activation, because a fresh host has no `data/state/projects.json`. The provisioner now seeds it.
   - Each of those attempts left an empty, never-activated destination: `hollywood_video_staging` with `rough-cut-staging`, and `hollywood_video_staging_local` with `rough-cut-staging-local`. They hold no data. They are left in place because removing them is a staging deletion, and cutovers only ever use fresh names.
7. **Observability:** `install-observability-runtime.py` then `configure-observability.py --enable`. The first managed start failed on two portability defects, both fixed in HV-032-04:
   - the launcher ran with a `PATH` that lacked `/usr/sbin`, where Debian keeps `useradd`;
   - it lost the supervisor settings;
   - its copied launcher could not find `host_config.py`.

   After the fixes, all three services run, Prometheus included.
8. **Point the loop at the host:**
   - `scripts/loop/loop.env` now sets `LOOP_STAGING_ROOT=/srv/rough-cut/staging` and exports the two supervisor settings.
   - `scripts/loop/conveyor.sh` deploys with `deploy-storage-staging.py --release-sha`; the JSON-era script refuses a PostgreSQL runtime.

**Still to do:**

- Upgrade the host to the merged release that carries these fixes (`--release-sha`), so observability restarts from the release itself.
- Re-record `wave-a-exit.json` and `observability-exit.json` there. HV-038's exit claim stays withdrawn until that run reads `instrumented: true`.
- **Reviewer reach.** The edge listens on `127.0.0.1:8081` inside the host, and Windows forwards `localhost:8081` to it. For a reviewer on another device, the operator publishes that port on the tailnet with `tailscale serve`, and `HV_FRONTEND_ORIGIN` is set to the resulting URL. That's a one-line operator step, taken when Release 1 reaches its review test.

## Provider profiles (HV-019-05)

Staging generates with mock providers unless the operator picks a live profile.

```
. /etc/rough-cut/host.env
A=$(cat $RC_RUNTIME/active-release.txt)
python3 $A/scripts/staging-providers.py --root $RC_RUNTIME --profile live-storyboards
```

| Profile | Rough cut (storyboard) | Final |
|---|---|---|
| `mock` | labelled colour slates, $0 | colour cards, $0 |
| `live-storyboards` | fal FLUX Schnell stills, about $0.003 each | colour cards, $0 |
| `live-film` | fal FLUX Schnell stills | fal Kling 2.5 Turbo Pro video, about $0.07 per second |
| `live-film-anchored` | fal FLUX Schnell stills | fal Kling O3 keyframes from the approved still, about $0.084 per second; Kling 2.5 for shots without a pinned still |

- **What changes.** Only the three provider lines of `runtime-config.sh`. The monthly ($500), per-shot and per-film caps stay where they are.
- **The key.** A live profile is refused unless `FAL_KEY` is in `secrets.env`; its value is never printed.
- **The record.** The choice is written to `provider-profile.json`, and the API and workers restart. A worker finishes its current job first.
- **Back to mock.** A cutover or rollback writes `mock` again, and so does `--profile mock`.

## Production voices (HV-022-03)

The studio's final films speak with Azure neural voices once the operator's voice catalogue exists and the voice setting is on.

```
. /etc/rough-cut/host.env; A=$(cat $RC_RUNTIME/active-release.txt); cd $A
set -a; . $RC_RUNTIME/secrets.env; set +a
$RC_RUNTIME/bin/bun scripts/audio-policy.ts --out $RC_RUNTIME/audio-policies.json --evidence $RC_RUNTIME/voice-evidence \
  --resource-id <the Speech resource ID> --sku S0 \
  --licence-url https://www.microsoft.com/licensing/terms/productoffering/MicrosoftAzure/MCA \
  --licence-url https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/text-to-speech/transparency-note \
  --licence-url https://learn.microsoft.com/en-us/legal/ai-code-of-conduct \
  --price-url https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/
python3 scripts/staging-providers.py --root $RC_RUNTIME --voice azure
```

- **What the catalogue script does.** It fetches Azure's East US voice list with the key (not billed; the key goes only in its header). It saves that list and the licence and price pages under `voice-evidence/`, and writes three policies (Guy, Davis, Jane) valid for a year, at mode 600.
- **`--voice azure`** first checks the catalogue with the application's own validator. It then writes only `HV_AUDIO_POLICY_FILE` into `runtime-config.sh` and restarts the API and workers.
- **Turning it off.** `--voice off` removes the setting, and so does any cutover or rollback.
- **Renewing it** changes the voices' permission, and films voiced under the old catalogue stop playing. Renew deliberately.
- **Costs.** Each take holds $0.03 until the operator allocates the Azure invoice (`bun scripts/reconcile-audio.ts`). Holds count toward the film's limit and the month's.

## Titles runtime

The Editor titles the studio's films (HV-025-03) only when the graphics renderer can find the pinned browser, Chrome Headless Shell 152.0.7977.75 (`GRAPHIC_CHROME_VERSION`). Without it, films are shared untitled with a note.

On this host, the browser and its Debian libraries are already installed at:

```
/srv/rough-cut/graphics-runtime/chrome-headless-shell/linux-152.0.7977.75/chrome-headless-shell-linux64/chrome-headless-shell
```

A smoke render passed there on 2026-09-20. To turn titles on:

```
. /etc/rough-cut/host.env; A=$(cat $RC_RUNTIME/active-release.txt)
python3 $A/scripts/staging-providers.py --root $RC_RUNTIME --titles chrome \
  --chrome-path /srv/rough-cut/graphics-runtime/chrome-headless-shell/linux-152.0.7977.75/chrome-headless-shell-linux64/chrome-headless-shell
```

- **What `--titles chrome` checks.** The path must be an executable file at an absolute path. Its `--version` output must contain 152.0.7977.75. Otherwise nothing is written.
- **What it changes.** It writes only `HV_GRAPHICS_CHROME_PATH` into `runtime-config.sh`, records the browser in `provider-profile.json`, and restarts the API and workers. The API reports the setting to the studio as `rendering.available` on `GET /api/projects/:id/graphics`. The workers render with it.
- **Turning it off.** `--titles off` removes the setting, and so does any cutover or rollback.
- **Installing it elsewhere.** `bun scripts/install-graphics-runtime.ts <cache directory>` downloads the pinned build and prints its path. The Debian libraries it needs are the host's to install.
- **Cost.** $0: nothing leaves the host.

## Slow studio routes (HV-032-06)

Staging's runtime configuration sets `HV_HTTP_IDLE_TIMEOUT_SECONDS=120`. The API's own default of 10 seconds closed the connection on the Editor's editorial source inspection, which takes about 11 seconds on this host, and the studio saw it as 502 "upstream unavailable". Every deploy, provision, cutover and rollback writes the setting.

## Risks

- **The desktop is a single machine.** Backups copied to `H:\…\backups` are on the same disk. Off-host recovery remains the open HV-038 item it already was, and needs a destination (G3).
- **Uptime is tied to the desktop.** A reboot for Windows Update stops staging until logon. The scheduled task brings it back, but only after a logon.
- **Reviewer reach.** Without Tailscale on the desktop, a reviewer on another device cannot reach staging, and Release 1's exit criterion 2 depends on that.
