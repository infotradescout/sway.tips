# Sway Demo Fixtures

This folder contains demo-only records for previewing Sway UI surfaces.

These records are not production data. They must stay visibly marked with:

- `demo: true`
- `fixtureSource: "demo-fixture-harness"`
- stable IDs beginning with `demo_`

## Enable

Set the client flag before building or running Vite:

```bash
VITE_SWAY_DEMO_MODE=true
```

## Disable

Leave the flag unset, or set:

```bash
VITE_SWAY_DEMO_MODE=false
```

Demo mode defaults off.

## Remove

Delete `fixtures/demo/` and keep `VITE_SWAY_DEMO_MODE=false`.

The production app must still build because app code does not statically import these fixture records.

## Surfaces

`sway-demo-fixtures.json` feeds read-only preview data for:

- public landing preview notes
- patron dashboard
- performer dashboard
- overlay ladder
- admin console preview
- moderation queue
- payment preview
- events feed
- profiles
- requests
- tips

## Split View

Split View is production UI architecture, not demo-only code.

The reusable component lives outside this fixture folder at:

```text
src/components/SplitViewShell.tsx
```

It is used by the patron, performer, and admin preview shells. It must render with real API state, demo fixture state, or empty state. Deleting this fixture folder must not remove or break Split View.
