# AITP Control Plane — documentation

The **control plane (CP)** is an API-only backend that hosts the registry, audit
event store, revocation list, and webhook fan-out for an
[AITP](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol)
deployment. It **observes and coordinates**; it never sits in the trust path.

These docs describe **the control plane** — its features, flow, architecture,
API, data model, and operations. They are **not** a copy of the AITP protocol.
The protocol is normatively defined by the **AITP RFCs** in the spec repo, and
the reference runtime is **`aitp-rs`**. Where a protocol detail matters, we
**link to the RFC** rather than restate it — if an RFC and a page here ever
disagree, **the RFC wins**. See [Protocol context](#protocol-context-dont-duplicate-the-spec).

## Purpose

AITP trust is **bilateral and peer-to-peer**: two agents authenticate each
other and issue each other short-lived Trust Context Tokens (TCTs) directly,
with no central authority in the path. That raises operational questions a
peer-to-peer protocol deliberately leaves open: *How does agent A find agent B?
What actually happened across a fleet of handshakes? How do operators revoke a
compromised token and notify subscribers?*

The control plane answers those **around** the protocol, without weakening it:

- **It is not a TCT issuer.** Agents issue TCTs to each other (RFC-AITP-0005). A central issuer would break the threat model.
- **It is not a gateway or proxy.** Handshake traffic (RFC-AITP-0004) is agent-to-agent; the CP never sees handshake payloads.
- **It is not a UI.** It serves JSON only; build a console separately (see [`aitp-ui-console`](https://github.com/agentidentitytrustprotocol/aitp-ui-console/blob/main/README.md)).

## Features

Links for each RFC below are in [Protocol context](#protocol-context-dont-duplicate-the-spec).

| Capability | What the CP does | Protocol anchor |
|---|---|---|
| **Agent registry** | Agents self-enroll with a one-time token; the CP caches their signed manifest and offered capabilities so peers can discover them | Manifest (RFC-AITP-0003); discovery is operational & [non-normative][disc] |
| **Audit event store** | Persists every handshake/TCT/delegation/revocation an agent reports; streams them live over SSE | — (CP telemetry) |
| **Revocation list** | Operators record revoked JTIs; the CP signs and serves a refreshed snapshot at `/.well-known/aitp-revocation-list` | Revocation (RFC-AITP-0008) |
| **Webhook outbox** | HMAC-signed, retried fan-out of selected event types to subscribers | — (CP feature) |
| **Trust store** | Org-scoped OIDC trust anchors and pinned-key allowlists agents can fetch at boot | Identity binding (RFC-AITP-0002) |
| **Observation projections** | Derives sessions, observed TCTs, and delegation chains from reported events | TCT (RFC-AITP-0005), Delegation (RFC-AITP-0006 / 0011) |

## Where it fits

```
        observe / coordinate (JSON over HTTP)
   ┌──────────────────────────────────────────────┐
   ▼                                               ▼
┌───────────────────┐                     ┌─────────────────────┐
│  Control Plane    │  discover peers     │  Agents (aitp-rs /  │
│  (this repo)      │◄────────────────────│  py / node)         │
│                   │  report events      │                     │
│  registry · audit │◄────────────────────│  publish manifests  │
│  revocation ·     │                     │                     │
│  webhooks · trust │      ┌──── 4-message handshake ────┐      │
│  store            │      │   (RFC-AITP-0004, p2p,       │      │
└───────────────────┘      │    CP never sees it)         │      │
   ▲                       └──────────────────────────────┘      │
   │ telemetry                                         (agent ◄──┘
   │                                                    ↔ agent)
┌───────────────────┐
│  aitp-playground  │  scenario runner → batches run telemetry to POST /api/events
└───────────────────┘
```

Typical agent interactions with the CP:

1. **Discover** peers — `GET /api/registry/agents?capability=demo.echo`
2. **Enroll** — `POST /api/registry/enroll` → `POST /api/registry/agents`
3. **Report** events — `POST /api/events` (handshake complete, TCT issued/revoked, delegation issued)

The handshake itself, and the verification of the manifests/TCTs exchanged in
it, happen **agent-to-agent** using the protocol — see `aitp-rs` and the RFCs.

## Contents

| Doc | What's in it |
|---|---|
| [`api.md`](api.md) | HTTP API reference — every route, auth, filters, request/response shapes, error codes, rate limiting, idempotency. Companion to [`../openapi.yaml`](../openapi.yaml). |
| [`events.md`](events.md) | Event reference — the envelope, which event types are recognized vs. merely stored, what each projects, and the webhook-deliverable set. |
| [`data-model.md`](data-model.md) | Postgres schema — every table, column, index, and the migration history. |
| [`operations.md`](operations.md) | Runbook — identity seed, revocation list, auth/exposure (and summaries of the request-gate, shipped-image and SSE harnesses), rate limiting, SSE capacity, webhook delivery, trust-anchor JWKS refresh, observed-artifact verification, data retention, observability/OTel, health & graceful shutdown, database, multi-tenancy. The per-check index of the shipped-image harness lives in [`internal_docs/IMAGE-HARNESS.md`](https://github.com/agentidentitytrustprotocol/aitp-control-plane/blob/main/internal_docs/IMAGE-HARNESS.md). |
| [`integration-playground.md`](integration-playground.md) | The stable integration contract with [`aitp-playground`](https://github.com/agentidentitytrustprotocol/aitp-playground). |

> **Published pages:** the docs listed above (and the top-level `README.md`) are
> mirrored to the docs website. This index page itself is **not** synced. Deployment
> and CI/CD live in [`../internal_docs/DEPLOY.md`](../internal_docs/DEPLOY.md), and
> the image-harness index in
> [`../internal_docs/IMAGE-HARNESS.md`](../internal_docs/IMAGE-HARNESS.md); both are
> **internal-only** and deliberately not published.

For build/quickstart and the env-var tables, see the top-level [`../README.md`](../README.md).

## Protocol context (don't duplicate the spec)

The AITP protocol and its reference implementation are documented elsewhere.
These CP docs link to them rather than restating wire formats, crypto, or trust
semantics. Canonical sources:

**Normative protocol — [AITP spec repo][spec]** (the RFCs win on any conflict):

| Concept used by the CP | Normative RFC |
|---|---|
| Core: AID forms ([§5.3](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0001-core.md#53-agent-id-aid)), JCS signing input ([§5.4.1](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0001-core.md#541-signing-input-jcs-profile)), Ed25519 / P-256 signature algorithms ([§5.4.3](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0001-core.md#543-algorithm-tagged-signature-wire-format-jcs-profile-only)), `cnf` JWK thumbprint ([§5.4.4](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0001-core.md#544-jwk-thumbprint-for-cnf)) | [RFC-AITP-0001 Core][rfc1] |
| Identity binding, trust anchors, pinned keys | [RFC-AITP-0002 Identity][rfc2] |
| Agent Manifest (the signed self-description the registry caches) | [RFC-AITP-0003 Manifest][rfc3] |
| Four-message mutual handshake (the CP never participates) | [RFC-AITP-0004 Handshake][rfc4] |
| Trust Context Token — issuer/subject/audience/`cnf` ([§3](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0005-tct.md#3-confirmation-claim-cnf)) (what `issued_tcts` mirrors) | [RFC-AITP-0005 TCT][rfc5] |
| Single-hop delegation | [RFC-AITP-0006 Delegation][rfc6] |
| Peer-key resolution | [RFC-AITP-0007 Key Resolution][rfc7] |
| Revocation (the signed list the CP serves; envelope signing [§1.5](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/RFC-AITP-0008-revocation.md#15-signed-revocation-response)) | [RFC-AITP-0008 Revocation][rfc8] |
| Threat model & required defenses | [RFC-AITP-0009 Security][rfc9] |
| Session Trust Bundle (Draft, opt-in — not part of v0.2 core conformance; the CP has no specific handling for it) | [RFC-AITP-0010 Session Trust Bundle][rfc10] |
| Multi-hop delegation (Draft, opt-in — not part of v0.2 core conformance) | [RFC-AITP-0011 Multi-hop][rfc11] |
| TCT renewal (Planned — a stub reserving the number; the CP has no specific handling for it) | [RFC-AITP-0013 TCT Renewal][rfc13] |
| Error-code registry — the CP reuses `MANIFEST_INVALID` / `MANIFEST_EXPIRED` from the [manifest codes](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/registries/error-codes.md#manifest-codes-rfc-aitp-0003) (the CP's `MANIFEST_INVALID` is broader than the registry's schema-only meaning); its other codes, such as `REVOCATION_UNAVAILABLE`, are CP HTTP codes, not registry entries. Agents verifying the CP's list report the [revocation codes](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/registries/error-codes.md#revocation-codes-rfc-aitp-0008) | [`registries/error-codes.md`](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/registries/error-codes.md) |
| Which repo owns which fact ([ownership rule](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/docs/ecosystem.md#ownership-rule), [repositories](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/docs/ecosystem.md#the-repositories)) | [`docs/ecosystem.md`](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/docs/ecosystem.md) |

Non-normative protocol guides: [Initial Peer Discovery][disc] · [Integration Guide][intg] · [Threat Model][threat] · [Glossary][gloss].

**Reference implementation — [`aitp-rs`][aitprs]:** how a peer is actually built
([architecture][rsarch]), and the SDKs agents use to handshake, issue TCTs, and
verify them ([Node][rsnode] · [Python][rspy]). The CP depends on the published
[`@agentidentitytrustprotocol/aitp`](https://www.npmjs.com/package/@agentidentitytrustprotocol/aitp)
package for its own identity and signing, not for any trust-path role.

## Sibling docs

These repos own the facts below; the CP docs link to them instead of copying.

| Repo | Doc | Use it for |
|---|---|---|
| Spec | [`rfcs/README.md`](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/rfcs/README.md) · [`docs/ecosystem.md`](https://github.com/agentidentitytrustprotocol/agentidentitytrustprotocol/blob/main/docs/ecosystem.md) | RFC index and status; which repo owns what |
| `aitp-rs` | [`docs/sdk-node.md`](https://github.com/agentidentitytrustprotocol/aitp-rs/blob/main/docs/sdk-node.md) ([manifest verification](https://github.com/agentidentitytrustprotocol/aitp-rs/blob/main/docs/sdk-node.md#manifest-verification), [revocation lists](https://github.com/agentidentitytrustprotocol/aitp-rs/blob/main/docs/sdk-node.md#revocation-lists-rfc-aitp-0008)) · [`docs/multihop-delegation.md`](https://github.com/agentidentitytrustprotocol/aitp-rs/blob/main/docs/multihop-delegation.md) · [`bindings/aitp-node/README.md`](https://github.com/agentidentitytrustprotocol/aitp-rs/blob/main/bindings/aitp-node/README.md) | The Node SDK the CP calls, its verify-code lists, multi-hop chain semantics |
| `aitp-playground` | [`docs/control-plane.md`](https://github.com/agentidentitytrustprotocol/aitp-playground/blob/main/docs/control-plane.md) | How the playground uses the CP (endpoints, discovery, event ingest, webhooks) |
| `aitp-docs` | [`README.md`](https://github.com/agentidentitytrustprotocol/aitp-docs/blob/main/README.md) | Cross-repo knowledge base and read-only MCP server |
| `aitp-ui-console` | [`README.md`](https://github.com/agentidentitytrustprotocol/aitp-ui-console/blob/main/README.md) | The console that reads this API |

## Source of truth

For **control-plane behavior**, the code wins — `src/proxy.ts` (auth + rate
limiting), `src/lib/config.ts` (env vars), `src/app/api/**/route.ts` (routes),
`src/lib/db/schema.ts` (tables). Keep these docs in sync when those change. For
**protocol behavior**, the RFCs win. This repo's `docs/*.md` (except this
`docs/README.md`) and the top-level `README.md` are mirrored to the
[docs website](https://agentidentitytrustprotocol.io/control-plane) on every push
to `main`; files in `../internal_docs/` are excluded.

[spec]: https://agentidentitytrustprotocol.io/spec
[rfc1]: https://agentidentitytrustprotocol.io/spec/core
[aitprs]: https://agentidentitytrustprotocol.io/implementation
[rfc2]: https://agentidentitytrustprotocol.io/spec/identity
[rfc3]: https://agentidentitytrustprotocol.io/spec/manifest
[rfc4]: https://agentidentitytrustprotocol.io/spec/mutual-handshake
[rfc5]: https://agentidentitytrustprotocol.io/spec/tct
[rfc6]: https://agentidentitytrustprotocol.io/spec/delegation
[rfc7]: https://agentidentitytrustprotocol.io/spec/key-resolution
[rfc8]: https://agentidentitytrustprotocol.io/spec/revocation
[rfc9]: https://agentidentitytrustprotocol.io/spec/security
[rfc10]: https://agentidentitytrustprotocol.io/spec/session-trust-bundle
[rfc11]: https://agentidentitytrustprotocol.io/spec/multihop-delegation
[rfc13]: https://agentidentitytrustprotocol.io/spec/tct-renewal-extension
[disc]: https://agentidentitytrustprotocol.io/docs/discovery
[intg]: https://agentidentitytrustprotocol.io/docs/integration-guide
[threat]: https://agentidentitytrustprotocol.io/docs/threat-model
[gloss]: https://agentidentitytrustprotocol.io/docs/glossary
[rsarch]: https://agentidentitytrustprotocol.io/implementation/architecture
[rsnode]: https://agentidentitytrustprotocol.io/sdks/node
[rspy]: https://agentidentitytrustprotocol.io/sdks/python
