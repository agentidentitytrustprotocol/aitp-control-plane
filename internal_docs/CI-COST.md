# CI cost

What GitHub Actions costs this repo, what was changed to keep it down, and the
rules that keep it there.

## Measurement (2026-10-08 to 2026-11-07)

Source: `gh api repos/agentidentitytrustprotocol/aitp-control-plane/actions/runs`
(215 runs, 846 job records) and the org billing usage summary filtered to this
repo.

| workflow / event | minutes (rounded up per job) |
|---|---|
| CI, pull_request | 466 |
| CI, push to main | 406 |
| CI, workflow_dispatch | 28 |
| bump aitp (repository_dispatch) | 24 |
| Notify Website (push) | 24 |
| Dependabot | 10 |
| auto-merge | 4 |
| **total** | **~962** (699 actual) |

Largest CI jobs: GHCR publish 233 min (push/dispatch only), `verify-image`
238 min, `Docker build check (PR)` 133 min, `build-and-test` 182 min,
`audit` 106 min. Every job ran on standard `ubuntu-latest`.

**Billed: $0.** The repo is public, so standard-runner minutes are free;
October's 1,290 minutes ($7.74 at list price) were fully discounted. The pass
below is about queue time and duplicated work, not money.

## Changes made (2026-11-07)

- **Removed `Docker build check (PR)`.** `Verify shipped image (amd64)` builds
  the same linux/amd64 image cold on every event and then boots and probes it,
  so the build-only job was a strict subset. In 30 days it never failed when
  `verify-image` passed (41 both passed, 15 both failed, 7 only `verify-image`
  failed). Done fail-closed, in this order: `Verify shipped image (amd64)` was
  added to branch protection's required checks first; the old context was
  dropped from the required set only after `verify-image` passed on this PR,
  immediately before merging it. Saves ~133 min / 30 days (~14%).
- **Required checks are now** `Build, typecheck, lint, test`,
  `Dependency audit (prod, high+)` and `Verify shipped image (amd64)` — the
  last one is stronger than the build-only check it replaces, so the PR bar
  went up, not down.

**Estimate:** ~962 → ~830 min / 30 days. Dollar cost unchanged at $0.

## Considered and not changed

- **Merge-queue path filter (`merge_group.base_sha`):** not applicable: there
  is no merge queue (classic protection, strict up-to-date, squash merges, so
  the PR run already tested the landed tree). If a queue is ever enabled, add
  the `merge_group` trigger and a fail-closed `changes` job in the same change
  (pattern: seam-runtime `.github/workflows/integration.yml`, the `changes`
  job: on fetch/diff failure or an empty diff it sets `relevant=true`).
- **Runners:** already the smallest standard runner; nothing to shrink.
- **Concurrency:** CI already cancels in-progress runs on PRs and never on
  push (publishing must finish).
- **Audit on push:** kept (~34 min). It catches an advisory published between
  the PR run and the merge.
- **Deploy path:** `docker-publish` and its `needs:
  [build-and-test, verify-image]` on push are the release gate and stay as-is.
  Wave 4 added a `deploy` job after it (main push only, gated on the repo
  variable `DEPLOY_TO_RAILWAY`): one small ubuntu job of curl + jq that polls
  Railway for at most 20 minutes, typically a few. No cache, no build.

## Rules

- Run the local gate (`npm run typecheck && npm run lint && npm test`, plus
  `npm run verify:gate` / `verify:image` for gate or image changes) before
  pushing; 22 of 69 PR runs in the window failed, i.e. CI was being used as the
  dev loop.
- One PR per change, draft until ready; no speculative re-runs. Re-run a job
  only for an infrastructure error, and only once.
