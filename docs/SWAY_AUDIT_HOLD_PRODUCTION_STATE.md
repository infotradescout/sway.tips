# Sway Audit Hold Production State

Date: 2026-06-14
Status updated: 2026-07-26

## Decision

HOLD LIFTED - 2026-07-26

This supersedes `AUDIT HOLD - PRODUCTION STATE RECONCILED` (2026-06-14).

The hold set one exit condition: an audit slice mapping the live surfaces and producing a prioritized fix backlog. That slice was delivered as `docs/SWAY_PRODUCTION_SURFACE_MAP.md` — route inventory, live route behavior, metadata/header/accessibility findings, and a P0/P1/P2/P3 backlog. The exit condition is met and product work is not paused.

This lift covers the blanket product-work freeze only. It is not a readiness claim, and it does not clear any narrower evidence gate. The audio master-storage `HOLD` in `docs/qa-packets/2026-07-22-audio-production-evidence.md` remains in force on its own terms.

Everything below is the 2026-06-14 record, retained as history. The production commits it names are historical and no longer describe current production.

## Production Truth At Audit Time (historical)

Intended production commit as of 2026-06-14:

```text
df1d44a9dd34ce871247e1262b061cc515b060e0
```

This commit supersedes the previous verified deployment commit:

```text
3c693004515839d29fd3ad0a431d72eff8a51451
```

The change from `3c6930...` to `df1d44...` is intentional. `df1d44...` is the deeper panel copy cleanup commit on `main` and `origin/main`.

## Reconciliation Evidence

Local Git evidence:

```text
df1d44a (HEAD -> main, origin/main, origin/HEAD, copy/deeper-panel-cleanup) Polish deeper panel copy
3c69300 test: polish sway mobile top-bar copy
```

Diff from previous production:

```text
df1d44a Polish deeper panel copy
15 files changed, 38 insertions(+), 37 deletions(-)
```

Branches containing `df1d44...`:

```text
copy/deeper-panel-cleanup
main
origin/main
```

## Marker Evidence

All checked production marker endpoints served:

```text
commit: df1d44a9dd34ce871247e1262b061cc515b060e0
branch: main
buildTimestamp: 2026-06-14T20:08:00.509Z
nodeEnv: production
```

Checked endpoints:

```text
https://sway.tips/api/build-marker
https://www.sway.tips/api/build-marker
https://app.sway.tips/api/build-marker
https://sway-tips.onrender.com/api/build-marker
```

## Original Hold Terms (satisfied 2026-07-26)

Recorded 2026-06-14: the production-state drift concern is resolved, but the app should remain in audit/freeze mode. The next slice should not be feature work or another narrow copy patch.

Next slice:

```text
audit/production-state-and-surface-map
```

Delivered as `docs/SWAY_PRODUCTION_SURFACE_MAP.md`.

Required output:

```text
- current production commit recorded
- public/app route inventory
- homepage and app entry screenshots
- deeper panel inventory
- copy issues classified by severity
- metadata, robots, sitemap, canonical, and social preview check
- basic security header check
- keyboard/accessibility smoke notes
- next three implementation slices
```

## Release-State Rule

Every future deployment packet should declare the intended production commit before deploy and the observed production commit after deploy.

Before deploy:

```text
Intended production commit:
Reason for deploy:
Risk level:
Rollback commit:
Routes to verify:
Expected marker timestamp:
```

After deploy:

```text
Observed production commit:
Observed timestamp:
Apex result:
www result:
App result:
Render origin result:
Diff from previous production:
Decision:
Carry-forward risks:
```
