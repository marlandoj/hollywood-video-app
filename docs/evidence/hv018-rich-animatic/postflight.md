# HV-018 delivered: storyboard and rich animatic

Verified 2026-09-05 on main `12bde2a66aa02855e62bb0a8f311dbca0172deff`.
PRs [9](https://github.com/marlandoj/hollywood-video-app/pull/9),
[10](https://github.com/marlandoj/hollywood-video-app/pull/10) and
[11](https://github.com/marlandoj/hollywood-video-app/pull/11) are merged after their required
quality and benchmark checks passed. Full execution and private rollout were authorized by the operator.

The preview now renders one still per planned shot, applies a seeded camera move, preserves complete
temporary speech, and provides sequential switchable captions plus optional burned captions.
Speech can extend a preview shot to avoid truncation. Mock rendering is deterministic and costs $0.
Signed, scene-grouped storyboard thumbnails appear beside the approval flow. Failed decisions can
be retried; resuming a preview disables duplicate generation until the approval decision is resolved.

## Evidence

- 219 tests, 1039 assertions: all pass. Typecheck, lint, build, runtime smoke, container/mTLS checks pass in CI.
- Same-host legacy benchmark: +2.0% pipeline latency versus 39ae2b6, within the existing 5% gate.
- New independent animatic gate: 24 posters, 720 decoded video frames, $0; runs in CI.
- Full Spud screenplay: 16 scenes, 24 storyboard clips, 601.967-second H.264/AAC preview, 14 narrated shots.
- Isolated mock: 95.880 s, $0. Isolated fal: 167.948 s, $0.072.
- Managed staging mock: 96.359 s, 24 signed PNGs, $0, 79 cookie-free responses.
- Managed staging fal: 166.665 s, 24 signed PNGs, $0.072, 114 cookie-free responses.
- Total live evaluation expense: $0.144. The 24 isolated fal events were copied once into the
  authoritative staging ledger by job/shot/timestamp, so the monthly ledger includes both runs.
  No reservations remain. HV-018 allocation: $150 inside the $500 Wave B evaluation envelope.
- Browser on the deployed private edge: playback reached 20.827 seconds, captions visible, all
  24 images present, scene disclosure works. Phone viewport: page width equals viewport width
  (375 px content area), with no horizontal overflow. Screenshot observations are in this Codex task.
- Request-changes flow verified. Separate mock project approved through the UI and reached
  a final 36.5-second export, readyState 4, attached captions, and no browser console errors.
  The final mock export is still a diagnostic placeholder; generated final performance is later scope.
- Downloaded rich preview SHA-256:
  `496ef88a57e93264f03b547160667735ea98b9dbb6340c784f86f0a1f22d4daf`
  (101646549 bytes). The local copy matches the server file.

## Gap audit

| Boundary | Result |
| --- | --- |
| Reachability | Managed API admission → leased worker → assembly → signed HLS/PNG → browser playback and approval exercised. |
| Data prerequisites | ffmpeg, ffprobe, espeak-ng and fonts installed. Existing fal credential bound only to project runtime secrets on Zo. |
| Environment parity | API and worker source the same provider/cap configuration. Managed fal inference tested; current default returned to mock. |
| Accounting | Reservations acquired at admission, per-attempt costs recorded, terminal reservations released; corrupt ledger fails closed. |
| Identifiers and artifacts | All 24 storyboard URLs returned PNGs. HLS segment, caption track, screenplay-bound decisions and downloaded checksum verified. |
| Rollback | Reverted to the pre-migration build: HTTP 200, legacy ledger with all 174 then-existing events and $0.072 intact. Redeployed successfully. |
| UI | Full dialogue preserved; sequential readable captions; grouped images; duplicate generation disabled during review; failed decision retry retained. |

The first rollout hit a cross-device directory rename. Deployment now writes an active-release pointer
and leaves old directories intact; startup scripts select the release without moving a mount.
Rollback retains current data and charges, converting only the ledger format for older code.
Private backups are under the existing runtime; no capability URLs or secrets are committed.

Current staging is private at https://modal.taile8ba2a.ts.net. Default provider is mock, narration is
enabled, and captions are switchable. No public branding or launch gate was bypassed.

Temporary speech is a local table-read voice. These are moving storyboards, not generated live action.
Identity consistency, voice casting, editable camera keyframes and the provider router remain their
separate full-scope milestones. Shadow persona records are routing checks, not independent review.
