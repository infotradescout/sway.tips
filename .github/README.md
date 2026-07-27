# GitHub automation policy

GitHub Actions is intentionally not used by this repository.

- Release verification runs locally against the exact commit under review.
- `npm run validate` is the standard local PR lane (`lint`, `build`, `test:contracts`).
- The pull request records the commands run, their results, and anything not run.
- Render deploys production from commits to `main`; Actions is not part of deployment.
- Do not add files under `.github/workflows/` without explicit owner approval.

## Why the workflows were removed

Two workflows remained here after Actions stopped being used: `ci.yml` and
`production-deploy-drift-guard.yml`. Neither had executed since
2026-07-23 — every run completed in about two seconds with no runner assigned
and zero steps run. They produced a permanently red check on every pull
request, identical on a documentation change and on a payment change, which is
worse than no signal at all because it looks like one.

TradeScout retired its own Actions the same way on 2026-07-26.

## What replaced the drift guard

`production-deploy-drift-guard.yml` was doing real work: after a push to
`main` it polled the production build-marker endpoints until every domain
reported the pushed commit, which is the automated form of the Release-State
Rule in `docs/SWAY_AUDIT_HOLD_PRODUCTION_STATE.md`.

That logic was preserved rather than deleted. It now runs on demand:

```bash
npm run guard:production-drift            # verify local HEAD reached production
npm run guard:production-drift -- <sha>   # verify a specific commit
```

It checks the same three domains with the same 15-minute timeout and 30-second
interval, and exits non-zero on mismatch or timeout. Run it after a deploy to
record the observed production commit.

See [`RELEASE_CONTROL.md`](../RELEASE_CONTROL.md) for the release process.
