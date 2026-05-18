# Manual screen-reader + keyboard accessibility walk

> **Status:** wave-end gate companion to the automated
> `@axe-core/playwright` CI job (PR-A7, phase-a appendix #16 /
> wave-16). The CI job covers what axe can detect mechanically;
> this checklist covers what only a real screen reader + a real
> operator at a real keyboard can verify. Run it once per
> wave-end against the partner deployment before the wave is
> declared shippable.

---

## Scope

The walk targets WCAG 2.2 AA + the wave-16 acceptance criteria
from `docs/plan-appendix/phase-a-16-impeccable-ux.md`. Every
checklist item maps to a wave-16 PR — when a step fails, the
matching PR's behaviour has regressed.

## Test matrix

| Platform | Browser | Screen reader |
|----------|---------|---------------|
| macOS    | Safari  | VoiceOver     |
| Windows  | Firefox | NVDA          |

Run the matrix at least once per wave-end. The CI job already
runs the axe-core walk on chromium so a second SR variant on
chrome is redundant; Safari + Firefox are the gaps.

## Pre-flight

1. Disable the heartbeat-pulse loop temporarily if VoiceOver
   announces it ("application busy"): not required — the only
   loop in the design system is the operate-glyph pulse, which
   is decorative + role="presentation". Confirm VoiceOver does
   not announce it.
2. Make sure the operator account in the partner deployment is
   in the admin team. Reset the seed PAT if rotated.
3. Confirm `prefers-reduced-motion: reduce` is OFF at the OS
   level for steps 1–8; step 9 flips it ON.

---

## Checklist

### 1. Login (PR-A1, A3, A4)

- [ ] Open the partner deployment URL in a private window.
- [ ] SR announces page title + "opencoo, heading level 1" on
      the PAT-entry surface.
- [ ] Tab order reaches the input field; SR reads
      `t("auth.patFieldLabel")` + `t("auth.storageNote")` (the
      A3 helper-description chain).
- [ ] Paste an empty value; submit. SR announces
      `t("auth.patEmpty")` via `role="alert"`. No focus jumps.
- [ ] Paste a wrong-team PAT (a token from a non-admin
      account); submit. SR announces `t("auth.forbidden")` via
      the global live region (A4) AND the inline `role="alert"`
      (A1).
- [ ] Paste a correct PAT; SR announces successful auth via
      the toast region (B7 + A4).

### 2. Sidebar + Cmd-K palette (PR-A2, A5)

- [ ] On the Domains route, SR reads:
      `<header role="banner">` → `<nav aria-label="…">` → group
      headings (`<h2>` Operate / Knowledge / Governance /
      Diagnostics) → `<main aria-labelledby>` → page `<h1>`.
- [ ] Tab into the sidebar; SR announces "Operate, heading
      level 2". Roving-tabindex (A5) is on: ArrowDown moves
      between buttons in the group, ArrowLeft/ArrowRight (or
      ArrowUp/ArrowDown across group boundaries) crosses
      groups.
- [ ] Land on Agents; press Enter. SR announces the Agents
      route's `<h1>`.
- [ ] Press Cmd-K (macOS) / Ctrl-K elsewhere. SR announces
      "Search command palette, combobox". `aria-expanded`
      flips to "true". Type a partial domain slug; SR
      announces the focused option count + the
      `aria-activedescendant` row.
- [ ] Enter to navigate. SR re-announces the destination
      route's `<h1>` + the third breadcrumb segment.

### 3. Edit a non-destructive field with optimistic UI (PR-B5, A4)

- [ ] On an Agents row drill-down, locate the `name` field.
      Rename `morning` → `weekday-morning`. SR announces field
      label + current value + the helper chain.
- [ ] As you type, the inline live-validation chip updates
      (B4). SR announces "Name OK" or "Name too long" without
      stealing focus.
- [ ] On commit, the new name appears immediately (B5
      optimistic apply); the saving-cue dot fades in (one-shot
      600ms, NOT a loop); the PATCH confirms; the dot fades
      out; SR announces "Agent instance renamed to
      weekday-morning" via the toast region (A4 + B7).

### 4. Force a 422 rollback (PR-B5, B7)

- [ ] Edit the same `name` field to a string ≥ 101 chars
      (override schema's `.max(100)`).
- [ ] New name appears optimistically (B5); the saving-cue
      dot fades in then turns red; rollback restores the
      previous value; SR announces the alert-toned toast
      "Name must be ≤100 chars" via the global region.
- [ ] Expand the toast's "Show details"; SR reads the
      mono-formatted 422 body field-by-field. `aria-expanded`
      on the toggle flips.

### 5. Locale switch + Polish narration (PR-C2, C3)

- [ ] In the TopBar, locate the LocaleSwitcher (C2). SR
      announces `t("locale.switcherAriaLabel")` =
      "Interface language".
- [ ] Flip to `pl`. SR announces "Language changed to
      Polski" via the live region.
- [ ] Walk steps 2–4 again in Polish. Confirm:
      - sidebar groups + tab labels are translated;
      - validation chips render Polish (B4 + C3);
      - toast tone tags stay as `OK` / `ADVISORY` / `ALERT`
        (intentional — design-system requires mono
        micro-labels untranslated);
      - the sovereignty-token countdown on the prompts apply
        flow announces in Polish.
- [ ] Open the Prompts route. Pick a prompt + a domain that
      has no override; click "Edit". SR announces the
      `<textarea>` label + helper. Click "Preview changes";
      the DiffPreviewDialog opens; SR announces "diff preview
      dialog". Walk through the line-level diff via
      arrow-down; each `add`/`del` line is read aloud.

### 6. Fresh-deploy onboarding wizard (PR-B6)

- [ ] On a separate engine instance: `docker compose down -v`
      then `up`. Land on Domains with zero rows.
- [ ] SR announces the onboarding wizard inline ("Step 1 of
      4, Create a domain"). Walk steps 1–4 keyboard-only:
      arrow keys to navigate steps, Enter to invoke each
      step's CTA. Each step opens the matching modal (PR-A1
      `<dialog>`). Confirm focus returns to the wizard CTA on
      modal-close.
- [ ] Step 4 ("Wait for the first heartbeat") polls
      `/api/admin/heartbeat/preconditions` (PR-W8) and
      announces "Watching for run…" until the dispatch lands.
- [ ] Cmd-K → "Run onboarding wizard". The wizard re-summons
      on top of the current route even when previously
      dismissed (B6 re-summon entry).

### 7. Density toggle (PR-C6)

- [ ] In the TopBar, locate the density toggle. SR announces
      `t("density.ariaLabel")` = "Interface density".
- [ ] Flip to `compact`. Verify:
      - sidebar row height tightens (no animation);
      - the Cmd-K palette's row height adapts;
      - SR re-announces the active tab without reflow.
- [ ] Re-run the contrast sweep (A6 CI): density-mode-scoped
      vars don't introduce any pair below the 4.5:1 floor.

### 8. Reduced-motion (PR-C5, B5, B7)

- [ ] At the OS level, enable `prefers-reduced-motion:
      reduce` (macOS: System Settings → Accessibility →
      Display → Reduce motion; Windows: Settings → Ease of
      access → Display → Show animations).
- [ ] Reload the SPA. Verify:
      - heartbeat-pulse on the operate glyph stops (or steps
        to one-shot per the design-system rule);
      - B5 saving-cue clamps to ≤ 80ms;
      - C5 hover transitions clamp;
      - B7 toast mount/dismiss is instant.
- [ ] SR walks steps 3–5 again without any motion regression.

### 9. axe-core CI artefact (PR-A7)

- [ ] Confirm the latest `accessibility` workflow run on the
      release commit is green. Pull the
      `axe-playwright-report` artifact if anything is yellow
      and triage moderate/minor violations as candidate
      follow-up.

---

## Sign-off

When all nine sections pass on both `Safari/VoiceOver` and
`Firefox/NVDA`, the wave-16 accessibility gate clears. Record
the date, the OS + SR versions, and the operator's initials in
`CHANGES-v0.1.md` wave-16 closeout (PR-WZN).

A failing step blocks the wave; file the regression as a
fix-up PR on top of `0.1.0-a.14.<final>` and re-walk only the
affected section after the fix lands.
