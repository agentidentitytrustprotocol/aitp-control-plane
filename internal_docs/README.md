# Internal docs

Operational and deployment documentation for the team running this service.

**These files are deliberately kept out of `docs/` so they are NOT published to
the public AITP website.** The website sync ([`aitp-website`]) globs
`docs/*.md`; anything here is invisible to it, and edits here do not trigger a
docs rebuild.

Put a doc here when it is infra/deployment/operational detail specific to *our*
hosting (CI pipelines, registry credentials, cloud provider steps, secrets
handling, internal runbooks) rather than something an external reader of the
control-plane API would need. Reader-facing material — API reference, event
model, data model, runtime configuration — belongs in [`../docs/`](../docs/README.md)
and is published.

## Contents

| Doc | What's in it |
|---|---|
| [`DEPLOY.md`](DEPLOY.md) | CI/CD pipeline (GHCR image build/publish) and a step-by-step Railway deployment guide, including the required environment variables and a local image smoke test. |
| [`IMAGE-HARNESS.md`](IMAGE-HARNESS.md) | Maintainer index for the shipped-image harness (`npm run verify:image`): the 27 checks with a one-line rationale each, pointers into the `scripts/verify-image.mjs` header, baseline regeneration rules, the CI jobs that run it, and teardown behaviour. Moved out of `docs/operations.md` for reader triage, not secrecy — the repo is public. |

[`aitp-website`]: https://github.com/agentidentitytrustprotocol/aitp-website
