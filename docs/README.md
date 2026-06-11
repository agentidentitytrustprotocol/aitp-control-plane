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
- **It is not a UI.** It serves JSON only; build a console separately (see [`aitp-ui-console`](https://github.com/agentidentitytrustprotocol)).

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
| [`operations.md`](operations.md) | Runbook — identity seed, auth/exposure, rate limiting, SSE capacity, data retention, observability/OTel, health & graceful shutdown, multi-tenancy. |
| [`integration-playground.md`](integration-playground.md) | The stable integration contract with [`aitp-playground`](https://github.com/agentidentitytrustprotocol/aitp-playground). |

> **Published pages** (these are mirrored to the docs website). Deployment and
> CI/CD live in [`../internal_docs/DEPLOY.md`](../internal_docs/DEPLOY.md), which
> is **internal-only** and deliberately not published.

For build/quickstart and the env-var tables, see the top-level [`../README.md`](../README.md).

## Protocol context (don't duplicate the spec)

The AITP protocol and its reference implementation are documented elsewhere.
These CP docs link to them rather than restating wire formats, crypto, or trust
semantics. Canonical sources:

**Normative protocol — [AITP spec repo][spec]** (the RFCs win on any conflict):

| Concept used by the CP | Normative RFC |
|---|---|
| Identity binding, trust anchors, pinned keys | [RFC-AITP-0002 Identity][rfc2] |
| Agent Manifest (the signed self-description the registry caches) | [RFC-AITP-0003 Manifest][rfc3] |
| Four-message mutual handshake (the CP never participates) | [RFC-AITP-0004 Handshake][rfc4] |
| Trust Context Token — issuer/subject/audience/`cnf` (what `issued_tcts` mirrors) | [RFC-AITP-0005 TCT][rfc5] |
| Single-hop delegation | [RFC-AITP-0006 Delegation][rfc6] |
| Peer-key resolution | [RFC-AITP-0007 Key Resolution][rfc7] |
| Revocation (the signed list the CP serves) | [RFC-AITP-0008 Revocation][rfc8] |
| Threat model & required defenses | [RFC-AITP-0009 Security][rfc9] |
| Multi-hop delegation (draft) | [RFC-AITP-0011 Multi-hop][rfc11] |

Non-normative protocol guides: [Initial Peer Discovery][disc] · [Integration Guide][intg] · [Threat Model][threat] · [Glossary][gloss].

**Reference implementation — [`aitp-rs`][aitprs]:** how a peer is actually built
([architecture][rsarch]), and the SDKs agents use to handshake, issue TCTs, and
verify them ([Node][rsnode] · [Python][rspy]). The CP depends on the published
[`@agentidentitytrustprotocol/aitp`](https://www.npmjs.com/package/@agentidentitytrustprotocol/aitp)
package for its own identity and signing, not for any trust-path role.

## Source of truth

For **control-plane behavior**, the code wins — `src/middleware.ts` (auth + rate
limiting), `src/lib/config.ts` (env vars), `src/app/api/**/route.ts` (routes),
`src/lib/db/schema.ts` (tables). Keep these docs in sync when those change. For
**protocol behavior**, the RFCs win. This repo's `docs/**` and `README.md` are
mirrored to the [docs website](https://agentidentitytrustprotocol.io/control-plane)
on every push to `main` (files in `../internal_docs/` are excluded).

[spec]: https://agentidentitytrustprotocol.io/spec
[aitprs]: https://agentidentitytrustprotocol.io/implementation
[rfc2]: https://agentidentitytrustprotocol.io/spec/identity
[rfc3]: https://agentidentitytrustprotocol.io/spec/manifest
[rfc4]: https://agentidentitytrustprotocol.io/spec/mutual-handshake
[rfc5]: https://agentidentitytrustprotocol.io/spec/tct
[rfc6]: https://agentidentitytrustprotocol.io/spec/delegation
[rfc7]: https://agentidentitytrustprotocol.io/spec/key-resolution
[rfc8]: https://agentidentitytrustprotocol.io/spec/revocation
[rfc9]: https://agentidentitytrustprotocol.io/spec/security
[rfc11]: https://agentidentitytrustprotocol.io/spec/multihop-delegation
[disc]: https://agentidentitytrustprotocol.io/docs/discovery
[intg]: https://agentidentitytrustprotocol.io/docs/integration-guide
[threat]: https://agentidentitytrustprotocol.io/docs/threat-model
[gloss]: https://agentidentitytrustprotocol.io/docs/glossary
[rsarch]: https://agentidentitytrustprotocol.io/implementation/architecture
[rsnode]: https://agentidentitytrustprotocol.io/sdks/node
[rspy]: https://agentidentitytrustprotocol.io/sdks/python
