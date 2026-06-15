# Sway Front End UI QA Guide

QA starts with user flow, not code.

## Flow Inventory

- List each primary user flow.
- Identify the user, entry route, primary goal, and completion signal.
- Include first-time visitor, motivated user, skeptical user, performer, patron, operator/admin, and overlay viewer where applicable.

## Screen Inventory

- List every screen, panel, modal, drawer, menu, empty state, error state, and success state touched.
- Record desktop and mobile viewport coverage.
- Record production-vs-demo data boundary checks for each app route.

## Clickable Path Testing

- Click every button, link, tab, segmented control, icon button, menu item, and card link.
- Confirm the expected route, state change, disabled state, or validation message.
- Confirm clickables do not overlap and remain reachable on mobile.

## Forms And Validation Testing

- Test valid input, empty input, malformed input, long input, repeated submit, and slow submit.
- Confirm validation copy is user-facing and recovery-oriented.
- Confirm disabled states and pending states are visible.

## Empty, Loading, Error, And Success States

- Empty states must explain what belongs there and how to create it.
- Loading states must preserve context.
- Error states must say what happened, what to try, and whether data is safe.
- Success states must confirm the result and next step.

## Responsive Viewport Checks

- Test desktop, tablet, and mobile widths.
- Test at least one narrow mobile viewport.
- Check scrolling, sticky headers, fixed controls, and panel layout.

## Mobile QA

- Verify one-handed reach for core actions.
- Check tap target size and spacing.
- Check text wrapping and clipped labels.
- Check soft keyboard behavior on form routes.

## Visual Overlap Checks

- Check for overlapping text, buttons, icons, panels, banners, and modals.
- Check hover/focus states do not shift layout.
- Check loading or dynamic content does not resize fixed-format controls.

## Console And Network Inspection

- Record browser console errors and warnings.
- Record failed network requests.
- Confirm API errors are handled with user-facing recovery.
- Confirm no debug/internal data leaks into the visible UI.

## Permissions And Roles

- Test patron, performer, admin/operator, support, unauthenticated, and denied states when applicable.
- Confirm no client routing is treated as a security boundary.

## Realistic Messy Data

- Test long names, missing images, empty queues, many queue items, repeated names, high values, and stale state.
- Confirm the UI remains readable and truthful.

## Accessibility Basics

- Keyboard navigate every interactive path.
- Confirm visible focus.
- Confirm controls have accessible names.
- Confirm headings and labels are meaningful.
- Confirm contrast, motion, and tap target risks are logged.

## Browser Compatibility

- Test current Chrome/Edge.
- Test Safari/iOS or equivalent WebKit coverage before mobile release claims.
- Record browser and device details in QA evidence.

## Session Behavior

- Refresh deep links.
- Return after idle time.
- Test multiple tabs if state can change.
- Test signed-out, expired, and denied access states where applicable.

## AI Sloppiness Checks

- Search visible copy for placeholder, TODO, internal, debug, model, classifier, unsafe, fake, sample, preview, and demo leakage.
- Verify claims match implemented behavior.
- Verify repeated UI patterns are intentional and not copy-paste drift.

## Final Release Checks

- Attach feature-level checklist.
- Attach bug report list with priorities.
- Attach release evidence checklist.
- Attach rollback path.
- Attach owner approval when Critical/High issues remain.

