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

[`aitp-website`]: https://github.com/agentidentitytrustprotocol/aitp-website
