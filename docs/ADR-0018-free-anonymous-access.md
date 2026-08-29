# ADR-0018: Hollywood Video Free Anonymous Access

**Date:** 2026-08-28
**Status:** accepted
**Confidence:** 0.95 *(revisit only if the operator explicitly changes the access model or measured public capacity proves the hosted service unsustainable)*
**Supersedes:** —

## Context

The planning baseline required authentication, user payments, Stripe, credits, and
commercial tiers. The operator has instead required the product to be free and
usable by everyone without signup.

## Decision

Hollywood Video's complete core journey is zero-charge and anonymous. Visitors do
not provide identity or payment information. Revocable capability tokens, recovery
keys, fair queues, privacy-preserving abuse controls, and hard operator budgets
replace accounts and billing. Hosted inference costs remain operator-visible and
are funded by a bounded subsidy; capacity exhaustion may defer new generation but
must not block editing or export of completed work.

## Alternatives considered

- Freemium or subscriptions: rejected because paid tiers violate universal free access.
- Pass-through provider charges: rejected because users would still pay to finish a film.
- Required free accounts: rejected because signup itself is an access barrier.
- Unlimited anonymous rendering: rejected because unbounded abuse could eliminate
  availability for legitimate users.

## Consequences

The product removes checkout, billing, credit-ledger, and mandatory identity scope.
Anonymous project recovery and collaboration require capability-security design.
The operator accepts infrastructure and model costs, so fair-use admission,
capacity telemetry, hard budget stops, grants or sponsorship, efficient/open model
routing, and optional self-hosting become launch-critical. The escape hatch is to
pause new hosted generations or reduce capacity equally; a paid tier cannot be
introduced without a superseding operator-approved ADR.
