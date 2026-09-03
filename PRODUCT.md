# Rough Cut — Product

**Status:** Private implementation; public launch fail-closed
**Working title:** Rough Cut (previously "Hollywood Video")
**Control record:** `/home/workspace/Projects/hollywood-video`
**Canonical inputs:** `docs/PRD.md`, `docs/ADR-0018-free-anonymous-access.md`, `docs/ADR-0020-factory-execution-defaults.md`, `docs/spec/build-spec.json`

## Register

product

## Users

- Screenwriters and independent filmmakers who want to turn a Fountain screenplay into a watchable proof-of-concept film without account setup, API keys, or payment.
- Marketers and creators who need a short narrative or promotional video generated from a concise script or outline.
- Evaluators and researchers who need a reproducible 24-shot benchmark for comparing generation providers, quality, continuity, latency, and cost.
- Operators who manage queue fairness, monthly inference budget, provider health, safety review, and production launch gates.

## Product Purpose

Rough Cut is a free, anonymous, script-first AI filmmaking studio. The public alpha converts a Fountain screenplay into a reviewed animatic and validated H.264 MP4 without signup, payment, watermarks, or user billing. The operator funds inference and rendering; the product earns trust through transparent cost controls, reproducible evidence, deterministic benchmark results, and a self-hostable architecture.

Success means a visitor can paste a screenplay, review the animatic, receive a usable MP4, understand its provenance, and share the result without learning the underlying pipeline. Operator success means the system stays inside approved safety, security, quality, and budget limits without manual per-generation intervention.

## Scope Boundary

The first release includes screenplay parsing, shot planning, storyboard/animatic review, per-shot generation, continuity checks, assembly, captions, provenance manifests, anonymous signed review links, fair queues, cost accounting, and a public 24-shot benchmark. Accounts, payments, collaborative editing, public API access, advanced audio, 4K/HDR output, and any feature requiring a user to spend money are explicitly deferred.

Private deployment and public launch use different gates. Private staging proves the vertical slice. Public branding, terms publication, live paid generation, and public deployment remain blocked until name clearance, counsel review, benchmark acceptance, budget controls, security review, production-ready audit, and operator launch approval all pass.

## Brand Personality

Cinematic, direct, credible, and quietly playful. The product should feel like a working studio, not a novelty demo: calm controls, honest cost/capacity messaging, visible progress, and provenance that can be inspected. It may nod to film culture, but it must not imitate a branded video-rental identity or imply affiliation with any existing entertainment company.

## Anti-references

- Paid AI-video SaaS onboarding funnels with email capture and credit-card gates
- Generic dark-gradient AI startup landing pages with empty cinematic copy
- Video-rental store pastiche, imitation logos, or trademark-adjacent branding
- Cinematic effects that delay navigation or hide generation status
- Confusing technical dashboards exposed as the primary user experience
- Silent capacity failure, unexplained refusals, or untraceable generated media

## Strategic Design Principles

1. Script first. The screenplay is the primary artifact; the interface turns narrative structure into a previewable film plan.
2. Anonymous by default. Signed, expiring links replace accounts. No cookie banner, password flow, or payment wall may become required.
3. Review before spend. Users approve the storyboard/animatic before expensive per-shot video generation begins.
4. Evidence over claims. Quality, continuity, cost, provider performance, and launch readiness come from repeatable benchmarks and audit artifacts.
5. Fail closed. Missing safety, moderation, provenance, launch-name, budget, or verification evidence blocks the next stage.
6. Fair and bounded. Free capacity is queued, per-project GPU usage is fair, cost rollups are explicit, and monthly budget pressure automatically throttles intake.
7. Provenance is part of the product. Every generated frame and final MP4 should carry model, prompt-hash, seed, timestamp, and reproducibility metadata.

## Accessibility & Inclusion

Target WCAG 2.2 AA contrast and keyboard operability. Script entry, review controls, progress, error states, downloads, and report flows must be usable without a pointer and without color as the only state indicator. Respect `prefers-reduced-motion`, keep captions available as sidecar files, use readable language in public status and refusal messages, and avoid collecting personal data that would make anonymous use inaccessible or exclusionary.
