# ADR-0020: Hollywood Video Factory Execution Defaults and Public Launch Hold

**Date:** 2026-08-29
**Status:** accepted
**Confidence:** 0.9 *(revisit the provider defaults after the 24-shot benchmark or if counsel changes the operating boundary)*
**Supersedes:** —

## Context

The canonical build specification was structurally valid but held from Software
Factory export by unresolved provider, voice, and operating-entity choices. The
operator has directed the project to proceed through the factory from its current
state while ADR-0018 continues to require free anonymous access.

## Decision

Factory implementation proceeds in a private `hollywood-video-app` repository
under the existing Zouroboros development umbrella. The generator is provider
neutral and starts with a deterministic mock; HV-001 selects the paid production
primary and secondary only after the 24-shot benchmark and explicit operator
budget approval. Piper is the self-hosted alpha TTS default, with caption-only
silent output as the required degradation path. Development and private staging
may proceed, but public deployment, public branding, terms publication, and live
paid generation remain fail-closed until name clearance, counsel review, and the
launch acceptance gates are recorded.

## Alternatives considered

- Select Runway or Kling before benchmark evidence: rejected because it would
  turn an evidence gate into a guess and commit spend prematurely.
- Use ElevenLabs as the mandatory alpha voice path: rejected because it would
  make a paid provider a prerequisite for the free, self-hostable vertical slice.
- Block all engineering until counsel and trademark work finish: rejected because
  private implementation is reversible and does not create public reliance.

## Consequences

The specification can pass deterministic Factory export without weakening the
legal or budget gates. Provider adapters and benchmark evidence become early
critical-path work; no paid generation is reachable by default. Alpha voice
quality may be lower, but captions keep the end-to-end path usable. The escape
hatch is configuration-only: replace Piper or select production video providers
after evidence, or stop before public launch if counsel or name clearance fails.
