#!/usr/bin/env bash
# scripts/threat-model-preflight.sh — PR-P1 (phase-a appendix #8).
#
# Runs the five automatable checks from THREAT-MODEL.md §5 against the
# worktree's current HEAD and writes a markdown-paste-ready fragment
# to stdout. The maintainer pastes the output into
# docs/threat-model-signoff-0.1.0-a.md (or the per-tag equivalent) and
# spot-checks the 8 remaining maintainer-judgment items (items 2, 3,
# 4, 5, 6, 7, 8, 11) against the cited path:line refs.
#
# What it covers:
#
#   Check 1 — `pnpm lint` passes.
#     Catches the four (now five) ESLint boundary rules that enforce
#     §2 invariants 2 / 5 / 8 / 9 / 10 (no-direct-gitea-write,
#     no-direct-llm-sdk, no-update-append-only, no-feature-env-vars,
#     no-cross-engine-import).
#
#   Check 2 — `pnpm test:injection` passes.
#     The prompt-injection corpus per §4.2 (phase-a ship-blocker).
#
#   Check 3 — No raw `process.env.X` reads in production code.
#     Belt-and-suspenders against §2 invariant 9 (the lint rule covers
#     it; this grep catches anything mis-imported, dynamically built,
#     or sneaking past via `// eslint-disable`).
#
#   Check 4 — New `credentialSchema` exports since base.
#     §3.1 says every secret field carries `x-credential-field:
#     { secret: true }` so the management UI masks + encrypts. Lists
#     any new exports for the maintainer to spot-check that flag is set.
#
#   Check 5 — New internet-facing routes since base.
#     §4.1 lists three internet-facing surfaces; the doctor's
#     INTERNET_FACING_PATHS in `packages/cli/src/commands/doctor.ts`
#     is the live enumeration. Lists any new route declarations the
#     maintainer should cross-check against that list.
#
# Usage:
#   bash scripts/threat-model-preflight.sh
#   bash scripts/threat-model-preflight.sh --base 0.1.0-a   # diff base for checks 4+5
#   bash scripts/threat-model-preflight.sh --help
#
# Defaults:
#   --base resolves in this order:
#     (1) the `0.1.0-a` git tag if it exists
#     (2) HEAD~30 otherwise (covers a typical appendix's worth of
#         commits without tipping into noise)
#
# Exit code:
#   ALWAYS 0. The script's job is to enumerate every check and emit a
#   paste-able fragment; check status is conveyed via ✓/✗ markers in
#   the body. Conflating the two would make the script useless to the
#   maintainer when one check legitimately fails (the maintainer still
#   wants the rest of the output).
#
# Non-goals:
#   - This script is NOT wired into CI (per the appendix-#8 plan).
#     Per-PR §5 checklists already live inline in PR bodies; this is
#     the tag-time / phase-merge sweep.
#   - The 5 automatable checks reduce 4 of THREAT-MODEL §5's 12
#     line-bullet items to ✓ (items 1, 9, 10, 12 — invariants /
#     no-feature-env-vars / test-tier discipline / residual-risk
#     bookkeeping). The remaining 8 items need maintainer judgment
#     beyond the script:
#       - Items 3, 4, 5, 7 — touched by the automatable checks but
#         still need a maintainer eye (new adapter credentialSchema
#         flag / new LLM call through router + spotlighting / new
#         wiki write provenance / new admin UI action with CSRF +
#         audit).
#       - Items 2, 6, 8, 11 — pure per-PR §3 read (matching §3
#         section satisfied / new webhook HMAC + cap / new
#         internet-facing route enumerated / credentials never in
#         logs grep).
#     All 8 are pre-cited at path:line in the sign-off doc so the
#     maintainer can spot-check each in <30s.
#
# Implementation notes:
#   - All 5 checks run unconditionally even if an earlier one fails.
#   - Output is plain ASCII + UTF-8 markdown. No color codes (so the
#     paste survives email / GitHub / Slack rendering).
#   - On platforms where `pnpm` isn't available the script reports
#     "✗ pnpm not found" and continues — the maintainer can re-run
#     the missing step manually.

set -u  # nounset on; do NOT set -e (the script must run all 5 checks).

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

readonly REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || {
  echo "preflight: cannot cd to repo root ($REPO_ROOT)" >&2
  exit 0
}

# Argument parsing.
BASE_REF=""
SHOW_HELP=0
SHAPE_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      SHOW_HELP=1
      shift
      ;;
    --base)
      BASE_REF="${2:-}"
      shift 2
      ;;
    --base=*)
      BASE_REF="${1#--base=}"
      shift
      ;;
    --shape-only)
      SHAPE_ONLY=1
      shift
      ;;
    *)
      echo "preflight: unknown flag: $1 (try --help)" >&2
      exit 0
      ;;
  esac
done

if [[ "$SHOW_HELP" -eq 1 ]]; then
  cat <<'HELP'
threat-model-preflight — pre-flight the THREAT-MODEL.md §5 checklist.

Usage:
  bash scripts/threat-model-preflight.sh [--base <ref>] [--shape-only]

Flags:
  --base <ref>  Diff base for "new since" checks (4 + 5). Defaults to
                the `0.1.0-a` tag if present, else HEAD~30.
  --shape-only  Emit the markdown structure (header + 5 check headings
                + footer) WITHOUT actually running `pnpm lint`,
                `pnpm test:injection`, the `process.env.X` grep, or
                the diff-since-base scans. Each check's body shows a
                "(skipped — --shape-only)" placeholder. Used by the
                unit test (tests/threat-model-preflight.test.ts) to
                pin the CLI shape without paying the full ~30s cost
                of the underlying checks. Maintainers run the script
                WITHOUT this flag at tag time.
  --help        Show this message and exit.

Output: markdown to stdout. Paste into
        docs/threat-model-signoff-0.1.0-a.md (or per-tag equivalent).

Exit code: always 0. Status is conveyed via ✓/✗ in the body.
HELP
  exit 0
fi

# Resolve the base ref. We try `0.1.0-a` first; if absent (it doesn't
# yet exist when this script first lands), fall back to HEAD~30.
if [[ -z "$BASE_REF" ]]; then
  if git rev-parse --verify --quiet '0.1.0-a' >/dev/null 2>&1; then
    BASE_REF='0.1.0-a'
  else
    BASE_REF='HEAD~30'
  fi
fi

readonly HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
readonly TODAY="$(date +%Y-%m-%d)"

# ----------------------------------------------------------------------------
# Header
# ----------------------------------------------------------------------------

cat <<EOF
## §5 Automatable Checks (run ${TODAY} against ${HEAD_SHA})

> Paste this fragment into \`docs/threat-model-signoff-0.1.0-a.md\` (or per-tag equivalent).
> Diff base for "new since" checks: \`${BASE_REF}\`.

EOF

# ----------------------------------------------------------------------------
# Check 1: pnpm lint passes
# ----------------------------------------------------------------------------
# Catches every ESLint boundary rule:
#   no-feature-env-vars     (THREAT-MODEL §2 invariant 9)
#   no-cross-engine-import  (THREAT-MODEL §2 invariant 10)
#   no-direct-gitea-write   (THREAT-MODEL §2 invariant 2)
#   no-direct-llm-sdk       (THREAT-MODEL §2 invariant 5)
#   no-update-append-only   (THREAT-MODEL §2 invariant 8)
echo "### Check 1: pnpm lint passes (boundary rules covering §2 invariants 2/5/8/9/10)"
echo
if [[ "$SHAPE_ONLY" -eq 1 ]]; then
  echo "  (skipped — --shape-only)"
elif ! command -v pnpm >/dev/null 2>&1; then
  echo "  ✗ pnpm not found in PATH — re-run after \`corepack enable && pnpm install\`."
elif lint_out="$(pnpm -s lint 2>&1)"; then
  echo "  ✓ lint clean"
else
  echo "  ✗ lint failures — paste of \`pnpm lint\` follows:"
  echo
  echo '  ```'
  # Indent so the markdown renders as a code block under the bullet.
  echo "$lint_out" | sed 's/^/  /'
  echo '  ```'
fi
echo

# ----------------------------------------------------------------------------
# Check 2: pnpm test:injection passes
# ----------------------------------------------------------------------------
# The prompt-injection corpus per §4.2 — the phase-a ship-blocker.
echo "### Check 2: pnpm test:injection passes (prompt-injection corpus, §4.2 phase-a ship-blocker)"
echo
if [[ "$SHAPE_ONLY" -eq 1 ]]; then
  echo "  (skipped — --shape-only)"
elif ! command -v pnpm >/dev/null 2>&1; then
  echo "  ✗ pnpm not found in PATH."
elif inj_out="$(pnpm -s test:injection 2>&1)"; then
  echo "  ✓ injection corpus passes"
  # Surface the pass-count line if vitest emitted one — gives the
  # maintainer a one-glance sanity check on the size of the corpus.
  pass_summary="$(echo "$inj_out" | grep -E '(Tests|Test Files).*pass' | tail -2)"
  if [[ -n "$pass_summary" ]]; then
    echo
    echo '  ```'
    echo "$pass_summary" | sed 's/^/  /'
    echo '  ```'
  fi
else
  echo "  ✗ injection corpus failures — paste of \`pnpm test:injection\` follows:"
  echo
  echo '  ```'
  echo "$inj_out" | tail -80 | sed 's/^/  /'
  echo '  ```'
fi
echo

# ----------------------------------------------------------------------------
# Check 3: No raw `process.env.X` reads in production code
# ----------------------------------------------------------------------------
# Belt-and-suspenders against THREAT-MODEL §2 invariant 9 — the
# `no-feature-env-vars` ESLint rule already enforces this for
# allow-listed names; the grep catches dynamic accesses, computed
# keys, and any `// eslint-disable` escapes in production code.
#
# Excluded paths (rationale — mirrors `eslint.config.js` ignores +
# the no-feature-env-vars rule's allow-listed surfaces):
#   - **/tests/**                 : test code may exercise env shapes
#   - **/*.test.ts / .spec.ts     : same
#   - **/node_modules/**          : third-party deps
#   - **/dist/**                  : build output (regenerated)
#   - gitea-wiki-mcp-server/**    : separately-published MCP server,
#                                   globally ignored by eslint.config.js
#                                   (`packages/gitea-wiki-mcp-server/**`
#                                   in the global ignores block) — its
#                                   own env-config layer is not subject
#                                   to opencoo's engine boundary rules
#
# Also strip lines that are obviously comment-only (start with `*`,
# `//`, or `*` after whitespace) — those are documentation, not runtime
# reads.
echo "### Check 3: No raw \`process.env.X\` reads in production code"
echo
if [[ "$SHAPE_ONLY" -eq 1 ]]; then
  echo "  (skipped — --shape-only)"
else
  env_hits="$(grep -rn 'process\.env\.' packages/*/src/ 2>/dev/null \
    | grep -vE '/(tests?|__tests__)/|\.test\.ts$|\.spec\.ts$|/dist/|/node_modules/|gitea-wiki-mcp-server/' \
    | grep -vE ':[[:space:]]*(\*|//|/\*)' \
    || true)"
  if [[ -z "$env_hits" ]]; then
    echo "  ✓ no \`process.env.X\` hits in \`packages/*/src/\` (excluding test files, comments, and gitea-wiki-mcp-server which is eslint-ignored)"
  else
    echo "  ⚠ found \`process.env.X\` reads in production code — verify each is allow-listed:"
    echo
    echo '  ```'
    echo "$env_hits" | sed 's/^/  /'
    echo '  ```'
    echo
    echo "  (Cross-check against \`tools/eslint-plugin-opencoo/src/rules/no-feature-env-vars.ts\` allow-list.)"
  fi
fi
echo

# ----------------------------------------------------------------------------
# Check 4: New `credentialSchema` exports since base
# ----------------------------------------------------------------------------
# §3.1 says every secret field carries `x-credential-field:
# { secret: true }` so the management UI masks + encrypts. The grep
# below lists any new credentialSchema declarations under
# packages/adapters/ since BASE_REF — the maintainer spot-checks that
# every secret field in each new schema has the field set.
echo "### Check 4: New \`credentialSchema\` exports since \`${BASE_REF}\`"
echo
if [[ "$SHAPE_ONLY" -eq 1 ]]; then
  echo "  (skipped — --shape-only)"
elif ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
  echo "  ⚠ base ref \`${BASE_REF}\` not resolvable — skip and re-run with \`--base <ref>\`."
else
  changed_files="$(git diff --name-only "$BASE_REF"..HEAD -- packages/adapters/ 2>/dev/null \
    | grep -E '\.(ts|tsx)$' \
    | grep -vE '\.test\.ts$|/tests?/' \
    || true)"
  new_schemas=""
  if [[ -n "$changed_files" ]]; then
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      [[ ! -f "$f" ]] && continue
      if grep -lE 'credentialSchema[ :=]' "$f" >/dev/null 2>&1; then
        new_schemas+="${f}"$'\n'
      fi
    done <<<"$changed_files"
  fi
  if [[ -z "$new_schemas" ]]; then
    echo "  ✓ no new or modified \`credentialSchema\` exports under \`packages/adapters/\` since \`${BASE_REF}\`"
  else
    echo "  ⚠ adapters with credentialSchema-touching changes — verify every secret field is masked:"
    echo
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      echo "  - \`${f}\` (verify schema marks every secret field as encrypted/masked per §3.1)"
    done <<<"$new_schemas"
  fi
fi
echo

# ----------------------------------------------------------------------------
# Check 5: New internet-facing routes since base
# ----------------------------------------------------------------------------
# §4.1 lists three internet-facing surfaces. The doctor's
# INTERNET_FACING_PATHS at packages/cli/src/commands/doctor.ts is the
# live enumeration. The grep lists any new route declarations under
# packages/ — the maintainer cross-checks each against that const.
echo "### Check 5: New internet-facing routes since \`${BASE_REF}\`"
echo
if [[ "$SHAPE_ONLY" -eq 1 ]]; then
  echo "  (skipped — --shape-only)"
elif ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
  echo "  ⚠ base ref \`${BASE_REF}\` not resolvable — skip."
else
  changed_files="$(git diff --name-only "$BASE_REF"..HEAD -- packages/ 2>/dev/null \
    | grep -E '\.(ts|tsx)$' \
    | grep -vE '\.test\.ts$|/tests?/|/dist/' \
    || true)"
  route_hits=""
  if [[ -n "$changed_files" ]]; then
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      [[ ! -f "$f" ]] && continue
      # Match Fastify-style declarations:
      #   app.post(...)        — engine-scaffold and self-op routes
      #   args.app.post(...)   — admin-API route style
      #   server.post(...)     — gitea-wiki-mcp-server style
      # Strip obvious comment-only lines so the maintainer doesn't
      # waste time spot-checking docstrings.
      hits="$(grep -nE '(^|[^.])(app|server|fastify)\.(post|get|put|delete|patch)\b|args\.app\.(post|get|put|delete|patch)\b' "$f" 2>/dev/null \
        | grep -vE ':[[:space:]]*(\*|//|/\*)' \
        || true)"
      if [[ -n "$hits" ]]; then
        while IFS= read -r line; do
          [[ -z "$line" ]] && continue
          route_hits+="${f}:${line}"$'\n'
        done <<<"$hits"
      fi
    done <<<"$changed_files"
  fi
  if [[ -z "$route_hits" ]]; then
    echo "  ✓ no new route declarations under \`packages/\` since \`${BASE_REF}\`"
  else
    echo "  ⚠ route declarations changed since \`${BASE_REF}\` — cross-check each against \`packages/cli/src/commands/doctor.ts:INTERNET_FACING_PATHS\`:"
    echo
    echo '  ```'
    echo "$route_hits" | sed 's/^/  /'
    echo '  ```'
    echo
    echo "  Internal-only routes (BullMQ workers, in-process Fastify probes) are fine."
    echo "  External-reachable routes MUST be enumerated in \`INTERNET_FACING_PATHS\`."
  fi
fi
echo

# ----------------------------------------------------------------------------
# Footer
# ----------------------------------------------------------------------------

cat <<EOF
---

End of automatable checks. These 5 checks reduce 4 of THREAT-MODEL §5's
12 line-bullet items to ✓ (items 1, 9, 10, 12). The remaining 8 items
need maintainer judgment beyond the script:

  - Items 3, 4, 5, 7 — touched by the automatable checks above but
    still need a maintainer eye (credentialSchema secret flag / LLM
    call through router + spotlighting / wiki write provenance /
    admin UI action CSRF + audit).
  - Items 2, 6, 8, 11 — pure per-PR §3 read (matching §3 section
    satisfied / webhook HMAC + cap / internet-facing route in
    INTERNET_FACING_PATHS / credentials never in logs grep).

All 8 are pre-cited at \`path:line\` in the sign-off doc.
EOF

exit 0
