# Rough Cut

*Working title (previously "Hollywood Video"). The final name is still under review.*

Rough Cut turns a screenplay into a short film. You paste in a script,
review a rough animated preview, approve it, and download a finished video.
No account, no sign-up, no payment, and no watermark.

## What it does

1. **Write or paste a screenplay.** Scripts use the [Fountain](https://fountain.io)
   format, the plain-text standard that most screenwriting apps can export.
2. **Confirm you have the rights.** Before anything renders, you attest that
   you own the script or have permission to use it.
3. **Review the animatic.** The app builds a quick, low-cost preview of every
   shot so you can see the pacing before the expensive final render. Each
   plan has a shot budget (24 shots on the free tier), so a longer script is
   condensed to fit, with at least one shot for every scene.
4. **Approve or request changes.** Nothing final is generated until you
   approve the preview. If you edit the script after approving, the approval
   is cleared and you review again.
5. **Download your film.** The finished video is a standard MP4 that plays
   anywhere, with captions and streaming playback included.
6. **Share a review link.** Send a private link to a collaborator so they can
   watch the cut and approve it or ask for changes, also without an account.

## How privacy works

There are no logins. When you start a project, the app gives you a private
link. That link *is* your project: bookmark it or keep the tab open to come
back to it. Anyone with the link can open the project, so treat it like a
password.

- Project links stay valid for 72 hours after they are issued.
- Finished videos stay downloadable for 30 days after they finish rendering.
- All project data is deleted automatically after 30 days.
- The app never sets cookies and never tracks you across sites.

## Where the project stands

The software is complete for its first version and has passed its internal
reviews, but it is **not yet public**. Launch is on hold until the name,
legal terms, budget, and safety checks are signed off. Until then:

- Nothing is hosted on a public web address.
- The video generator runs in a placeholder mode that produces the right
  file shape without calling a paid AI service.
- Narration is not yet enabled. Exports include captions and silent audio
  until the voice engine is switched on.

Some things the app will refuse to make, regardless of the script: content
involving minors, real identifiable people, political deepfakes, trademarked
brands or characters, non-consensual intimate content, incitement, and hate.

## Running it yourself

You need three things installed:

- [Bun](https://bun.sh) 1.4.0 (the JavaScript runtime the app runs on)
- [Docker](https://docs.docker.com/get-docker/) with Docker Compose
- `ffmpeg` (only if you run the quick test without Docker; the Docker images
  include it)

Then, from a terminal in this folder:

```bash
bun install --frozen-lockfile
export HV_TOKEN_SECRET="replace-with-at-least-32-random-characters"
./infra/mtls/gen-certs.sh
docker compose up --build api queue-worker frontend
```

Open <http://localhost:8081> in a browser. The first screen asks for a
screenplay.

What each step does:

- `bun install` downloads the app's dependencies.
- `HV_TOKEN_SECRET` is the secret used to sign project links. Pick any long
  random string and keep it the same between restarts, or existing links
  will stop working.
- `gen-certs.sh` creates the certificates the internal services use to talk
  to each other securely. Run it once; the files are kept out of version
  control.
- `docker compose up` builds and starts the web page, the API, and the
  background worker that renders videos.

To stop everything, press `Ctrl+C`, then `docker compose down`. Your projects
and videos are kept in Docker volumes and survive restarts.

### A quick test without Docker

```bash
bun run smoke:runtime
```

This walks through a complete project from script to download on your
machine and reports whether every step behaved. It needs `ffmpeg` on your
PATH.

### Optional settings

These are set in `docker-compose.yml` and can be changed there:

| Setting | What it controls | Default |
|---|---|---|
| `HV_MONTHLY_BUDGET_USD` | Spending ceiling for the whole service each month. New work queues when 80% is reached. | 5000 |
| `HV_COST_CAP_PER_SHOT_USD` | Maximum spend on any single shot before the job is cancelled. | 5 |
| `HV_PROVIDER_PRIMARY` / `HV_PROVIDER_SECONDARY` | Which video generator to use, and the fallback if it fails. | `mock` |
| `HV_OPERATOR_GRANT_SECRET` | Enables an operator to grant a project higher capacity. Leave blank to keep everyone on the free tier. | blank |

## For developers

The codebase is a Bun monorepo under `packages/`: a web front end, an API, a
job queue and worker, a screenplay parser, a shot planner, a generator
adapter, a safety filter, an assembler that produces the MP4 and captions,
and a benchmark suite. Useful commands:

```bash
bun test              # run the test suite
bun run typecheck     # TypeScript checks
bun run lint          # lint
bun run benchmark     # record the quality and cost baseline
```

Design and requirements live in `docs/`:

- `docs/PRD.md` — full product requirements
- `docs/ADR-0018-free-anonymous-access.md` — why there are no accounts
- `docs/ADR-0020-factory-execution-defaults.md` — the launch hold and gates
- `docs/spec/` — the machine-readable build specification

## Licence and status

Private repository. Not licensed for redistribution while the working title
and terms are under review.
