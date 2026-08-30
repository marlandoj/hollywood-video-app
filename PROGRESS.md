# Hollywood Video — Factory Build Progress (ZOU-1566 / HV-000)

status: in_progress
watchdog: off

- [x] Seed adopted from docs/spec/factory-seed.yaml (source hash 612c3811…) + deterministic seed eval
- [x] M1 core: 10-package monorepo, parser conformance, safety gate, signed 72h tokens, version history
- [x] M2 core: mock provider, failover, cost cap, capacity tiers, fair share, continuity repair loop
- [x] M3 core: assembly (0.5s crossfade), captions SRT/VTT, ffprobe gate, byte-identical export, review links
- [x] M0: 24-shot benchmark fixture v1.0.0 + baseline + >5% CI regression gate
- [x] 12-shot E2E integration test (script → validated MP4)
- [ ] External gates (operator/human): name clearance, counsel review, beta, load/pen test, GA — fail-closed per ADR-0020
