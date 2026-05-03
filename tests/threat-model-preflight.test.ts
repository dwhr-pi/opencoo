/**
 * Tests for `scripts/threat-model-preflight.sh` (PR-P1, phase-a appendix #8).
 *
 * The pre-flight script is operator-grade tooling — its real test is
 * running it against the worktree's HEAD at tag time. These unit
 * tests pin the load-bearing surface so the script's CLI shape, exit
 * code, and the markdown headings the maintainer pastes into the
 * sign-off doc don't drift silently.
 *
 * What's tested here:
 *   - The script exists and is executable from the repo root.
 *   - The script exits 0 even when individual checks fail (so the
 *     maintainer always gets a paste-able fragment; check status is
 *     conveyed via ✓/✗ markers in the body, not the exit code).
 *   - stdout contains the canonical "§5 Automatable Checks" header
 *     and one heading per check (1-5).
 *   - Each of the 5 check headings is present so the maintainer can
 *     paste the fragment into the sign-off doc with confidence that
 *     no automatable item is silently missing.
 *
 * What's NOT tested here:
 *   - The ✓/✗ result for each check — that depends on the worktree's
 *     state at test time and would brittle the suite. The pre-flight
 *     is advisory: the maintainer reads each check's result; the
 *     script's job is to enumerate every check, not to gate.
 *   - The actual lint / test / grep invocations — those are
 *     observed in their own test suites.
 *
 * Performance: the test invokes the script with `--shape-only`, which
 * emits the markdown structure (header + 5 check headings + footer)
 * WITHOUT actually running `pnpm lint`, `pnpm test:injection`, the
 * `process.env.X` grep, or the diff-since-base scans. Each check's
 * body shows a "(skipped — --shape-only)" placeholder. This keeps the
 * unit test under 1s — without it, every `pnpm test` run would
 * recursively invoke the injection lane (which `vitest.config.ts`
 * explicitly excludes for speed) inside a vitest worker. The
 * maintainer runs the script WITHOUT this flag at tag time. (Round-3
 * Copilot finding #1.)
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "threat-model-preflight.sh");
// `--shape-only` runs in <100ms; the previous full-checks invocation
// took ~30s on a warm cache and minutes on cold. The default 10s
// vitest timeout is more than enough now — keep the explicit cap as
// a safety belt against a future regression that re-introduces real
// work in the shape-only path.
const SCRIPT_TIMEOUT_MS = 30_000;

describe("scripts/threat-model-preflight.sh", () => {
  let result: SpawnSyncReturns<string>;

  // Run the script ONCE for all 5 assertions with `--shape-only` so
  // the test pins the CLI shape without paying for the underlying
  // checks (Round-3 finding #1: a full invocation in `pnpm test`
  // recursively invokes `pnpm test:injection`, which
  // `vitest.config.ts` explicitly excludes from the main suite for
  // speed — recursion would 10× the suite cost on every PR run).
  beforeAll(() => {
    result = spawnSync("bash", [SCRIPT_PATH, "--shape-only"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT_MS,
    });
  }, SCRIPT_TIMEOUT_MS);

  it("exists at the canonical path", () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  it("exits 0 on a clean invocation (status conveyed via body markers, not exit code)", () => {
    expect(result.status).toBe(0);
  });

  it("emits the canonical §5 Automatable Checks header", () => {
    expect(result.stdout).toContain("§5 Automatable Checks");
  });

  it("enumerates all 5 automatable check headings", () => {
    // Each check is rendered as a markdown heading the maintainer
    // pastes into docs/threat-model-signoff-0.1.0-a.md. The set of
    // five matches THREAT-MODEL.md §5's automatable subset:
    //   1. pnpm lint passes (covers no-feature-env-vars + no-cross-engine-import + no-direct-gitea-write + no-update-append-only + no-direct-llm-sdk)
    //   2. pnpm test:injection passes (prompt-injection corpus per §4.2)
    //   3. No feature-env-var reads in production code
    //   4. New credentialSchema exports since base
    //   5. New internet-facing routes since base
    expect(result.stdout).toContain("Check 1: pnpm lint");
    expect(result.stdout).toContain("Check 2: pnpm test:injection");
    expect(result.stdout).toContain("Check 3:");
    expect(result.stdout).toContain("Check 4:");
    expect(result.stdout).toContain("Check 5:");
  });

  it("reports the closing commit SHA in the header (so the maintainer's paste is self-dating)", () => {
    // Header form: "## §5 Automatable Checks (run YYYY-MM-DD against <sha>)"
    // The exact SHA isn't asserted (depends on test-time HEAD); the
    // shape is — so a maintainer looking at the pasted fragment knows
    // which commit it ran against without re-running the script.
    expect(result.stdout).toMatch(/run \d{4}-\d{2}-\d{2} against [0-9a-f]{7,40}/);
  });
});
