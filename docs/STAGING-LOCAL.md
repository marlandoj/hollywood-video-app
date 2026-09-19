# Private staging on the operator's desktop

**Status:** planned. Decided by the operator on 2026-09-19 (G10-202609191100). Zo remains the staging host until the cutover below is verified. Zo stays available as a resource (memory, skills, RAG) after that.

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
| Push route from the build session | Bundle → Windows → `scp` to Zo → push (four hops) | Direct from the build session once the repository is connected to it; otherwise bundle → `H:` inbox → push from the host (two hops) |
| Secrets | Zo Secrets | A root-only env file inside the distribution, entered by the operator |

## Operator steps (one time, about 30 minutes)

Run everything below yourself, in the order given. None of it needs to be pasted into chat. **Never paste a token or key into the conversation.**

### 1. Install the distribution onto H:

In an **elevated** PowerShell:

```powershell
wsl --update
wsl --install --no-distribution          # reboot if it asks
New-Item -ItemType Directory -Force H:\Claude\Rough-Cut-Staging\wsl | Out-Null
wsl --install -d Debian --location H:\Claude\Rough-Cut-Staging\wsl --name rough-cut-staging
```

Create the Linux user it asks for.

If your WSL does not accept `--location` or `--name`, install `Debian` normally, then move it:

```powershell
wsl --export Debian H:\Claude\Rough-Cut-Staging\debian.tar
wsl --unregister Debian
wsl --import rough-cut-staging H:\Claude\Rough-Cut-Staging\wsl H:\Claude\Rough-Cut-Staging\debian.tar
Remove-Item H:\Claude\Rough-Cut-Staging\debian.tar
```

### 2. Keep it running

WSL stops an idle distribution. Add this to `%UserProfile%\.wslconfig`:

```ini
[wsl2]
vmIdleTimeout=-1
```

Then create a scheduled task that keeps one process alive in the distribution from logon:

```powershell
$a = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d rough-cut-staging -u root -- sleep infinity"
$t = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "Rough Cut staging" -Action $a -Trigger $t -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -Hidden) -RunLevel Highest
```

Set Windows power so the desktop does not sleep while staging should answer.

### 3. Turn on systemd and SSH inside it

Open the distribution (`wsl -d rough-cut-staging`) and run:

```sh
sudo sh -c 'printf "[boot]\nsystemd=true\n" > /etc/wsl.conf'
exit
```

Then, back in PowerShell: `wsl --shutdown` and `wsl -d rough-cut-staging`. Inside again:

```sh
sudo apt-get update && sudo apt-get install -y openssh-server
sudo sed -i 's/^#\?Port .*/Port 2222/; s/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo systemctl enable --now ssh
```

### 4. Give the build session the same access it has to Zo

The build session reaches Zo through the `zo-computer` SSH connector in the Claude desktop app, using your existing SSH key. Do the same for the new host:

- Append the **public** half of that key (for example `%UserProfile%\.ssh\id_ed25519.pub`) to `/root/.ssh/authorized_keys` inside the distribution. Use mode 700 on the folder and 600 on the file.
- Check from PowerShell that `ssh -p 2222 root@localhost true` returns without a prompt.
- Add a second instance of that connector to the Claude desktop configuration, named `rough-cut-local`, pointed at `root@localhost` port `2222`. If the connector's host is hard-coded, say so and we will pick another route.

### 5. GitHub

- **For pushes from the build session:** connect `marlandoj/hollywood-video-app` to the Claude session as a source. The build session's git proxy already names this as the missing piece: it refuses the push because the repository "is not in this session's authorized repository set". No token is needed on this route.
- **For the staging host** (fetching releases, CI status, merges): create a **fine-grained** personal access token.
  - **Repository access:** only `marlandoj/hollywood-video-app`.
  - **Permissions:** Contents read/write, Pull requests read/write, Actions read, Commit statuses read, Metadata read.
  - **Not granted:** **Workflows** (this enforces the `.github/workflows/**` freeze mechanically) and **Administration**.
  - **Expiry:** 90 days.
- Enter the token on the host yourself:

  ```sh
  sudo apt-get install -y gh
  sudo gh auth login --hostname github.com --git-protocol https   # choose "Paste an authentication token"
  ```

  The token then lives only in root's `gh` config on the host. It does not go in a file on `H:`, in the repository, or in chat.

### 6. Provider keys

Staging on Zo has two secrets: `HV_TOKEN_SECRET`, which is generated per host and does not need to move, and `FAL_KEY`. Put `FAL_KEY` into `/root/.config/rough-cut/secrets.env` (mode 600) yourself. Alternatively, approve the build session copying it host to host without printing it. The same applies to a voice-provider key once you choose one (G3).

## Build-session steps (after the operator steps)

1. **Parameterize the host paths.** Merge the portability increment: supervisor config path and runtime root become settings, with Zo's values as the defaults until cutover.
2. **Provision the host.** Install Python, supervisord, ffmpeg and the pinned Bun 1.4.0. Run `bootstrap-storage-platform.py`, which installs the pinned Postgres 15 and RustFS and generates **fresh** database, object-store and TLS credentials. None of Zo's are reused.
3. **Deploy the current `main`** with `deploy-storage-staging.py` and wait for `{"phase": "healthy"}`.
4. **Carry the data across as archives, not as a database copy.** Export Zo's projects as portable archives into `archives\` and import them on the new host. This also exercises HV-040's archive path on a real move. Staging data is test data, so an empty start is acceptable if an archive refuses.
5. **Re-record the evidence** (`wave-a-exit.json`, `observability-exit.json`) on the new host. Observability must come back `instrumented: true` before HV-038's claim is restored.
6. **Point the loop at the new host.** Update `scripts/loop/loop.env`, `CLAUDE.md`, `STORAGE-DEPLOYMENT.md` and this file, and record the cutover.
7. **Keep Zo's staging stopped but intact for one week as a fallback,** then ask the operator before removing it (a G8-class decision).

## Risks

- **The desktop is a single machine.** Backups copied to `H:\…\backups` are on the same disk. Off-host recovery remains the open HV-038 item it already was, and needs a destination (G3).
- **Uptime is tied to the desktop.** A reboot for Windows Update stops staging until logon. The scheduled task brings it back, but only after a logon.
- **Reviewer reach.** Without Tailscale on the desktop, a reviewer on another device cannot reach staging, and Release 1's exit criterion 2 depends on that.
