/**
 * commander parse + dispatch (PR 30 / plan #135).
 *
 * `parseAndDispatch` builds a fresh `Command` per call —
 * commander's global state would leak between tests if the
 * Command lived at module scope. Each command's runner
 * receives a focused args object; the parser does the
 * commander → args translation here so the runners stay test-
 * friendly (no commander dep).
 *
 * `--version` reads `version` from `package.json` (planner
 * Q11). The bin entry imports the const and threads it through
 * so the published artifact's version is the source of truth.
 */
import { Command } from "commander";

import {
  runAgentsSeed,
  type AgentsSeedArgs,
} from "./commands/agents-seed.js";
import { runDoctor, type DoctorArgs } from "./commands/doctor.js";
import { runMigrate, type MigrateArgs } from "./commands/migrate.js";
import { runRecompile, type RecompileArgs } from "./commands/recompile.js";
import { runServe, type ServeArgs } from "./commands/serve.js";
import {
  runSourceForget,
  type SourceForgetArgs,
} from "./commands/source-forget.js";
import type { SourceTestArgs } from "./commands/source-test.js";
import { runSetup, type SetupArgs } from "./commands/setup.js";

export interface ParseAndDispatchArgs {
  readonly argv: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly version: string;
  readonly stdout: { write: (s: string) => boolean };
  readonly stderr: { write: (s: string) => boolean };
  /** @internal Test seam — substitute the per-command runner. */
  readonly runners?: {
    readonly migrate?: (a: MigrateArgs) => Promise<void>;
    readonly setup?: (a: SetupArgs) => Promise<void>;
    readonly doctor?: (a: DoctorArgs) => Promise<void>;
    readonly agentsSeed?: (a: AgentsSeedArgs) => Promise<void>;
    /** `source test` runner — the parse layer doesn't have an
     *  AdapterRegistry to inject (that's bin.ts's job). The runner
     *  contract here OMITS `registry`; the production wrapper in
     *  bin.ts closes over the registry and passes it along. */
    readonly sourceTest?: (
      a: Omit<SourceTestArgs, "registry">,
    ) => Promise<void>;
    readonly sourceForget?: (a: SourceForgetArgs) => Promise<void>;
    readonly recompile?: (a: RecompileArgs) => Promise<void>;
    /** Bare-command runner — the long-running boot verb (phase-a
     *  appendix). `program.action(...)` fires only when no
     *  subcommand matches, which is exactly the no-arg
     *  `opencoo` boot path. */
    readonly serve?: (a: ServeArgs) => Promise<void>;
  };
}

export async function parseAndDispatch(
  args: ParseAndDispatchArgs,
): Promise<void> {
  const program = new Command();
  // commander defaults to stripping the program name from
  // argv[1] — when the test passes ['migrate', '--skip-migrate']
  // we skip the strip so the first arg is treated as a command.
  program
    .name("opencoo")
    .description(
      "opencoo operator CLI. Run `opencoo` with no subcommand to boot the long-running engine.",
    )
    .version(args.version)
    .exitOverride(); // throw on parse failure instead of process.exit

  const runners = args.runners ?? {};

  // Bare-command dispatch: `opencoo` (no subcommand, no flags)
  // boots the long-running engine (phase-a appendix; spec
  // architecture.md §14.5). `program.action(...)` fires only
  // when no subcommand matches AND no `--help`/`--version`
  // sentinel was triggered (commander handles those before
  // reaching the action).
  program.action(async () => {
    const fn = runners.serve ?? runServe;
    await fn({
      env: args.env,
      stdout: args.stdout,
      stderr: args.stderr,
    });
  });

  program
    .command("migrate")
    .description("Apply Drizzle migrations against DATABASE_URL")
    .option("--skip-migrate", "v0.1 no-op (forward-compat for v0.2 auto-migrate)", false)
    .action(async (opts: { skipMigrate?: boolean }) => {
      const fn = runners.migrate ?? runMigrate;
      await fn({
        env: args.env,
        skipMigrate: opts.skipMigrate ?? false,
        stdout: args.stdout,
        stderr: args.stderr,
      });
    });

  program
    .command("setup")
    .description("Interactively write a .env file (mode 0600)")
    .option("--yes", "non-interactive; every value sources from existing env", false)
    .action(async (opts: { yes?: boolean }) => {
      const fn = runners.setup ?? runSetup;
      await fn({
        cwd: args.cwd,
        env: args.env,
        nonInteractive: opts.yes ?? false,
        stdout: args.stdout,
        stderr: args.stderr,
      });
    });

  program
    .command("doctor")
    .description("Print engine + DB + Gitea team health checks")
    .option("--json", "emit structured JSON for CI", false)
    .option("--admin-pat <pat>", "Gitea PAT for the team-check; falls back to OPENCOO_ADMIN_PAT")
    .action(async (opts: { json?: boolean; adminPat?: string }) => {
      const fn = runners.doctor ?? runDoctor;
      const adminPat = opts.adminPat;
      await fn({
        env: args.env,
        json: opts.json ?? false,
        ...(typeof adminPat === "string" && adminPat.length > 0
          ? { adminPat }
          : {}),
        stdout: args.stdout,
        stderr: args.stderr,
      });
    });

  // `agents` namespace — seed default scheduled agent rows.
  const agents = program
    .command("agents")
    .description("Agent-instance operations");

  agents
    .command("seed")
    .description(
      "Idempotently insert default agent_instances rows for every scheduled-class agent (heartbeat, lint, surfacer)",
    )
    .action(async () => {
      const fn = runners.agentsSeed ?? runAgentsSeed;
      await fn({
        env: args.env,
        stdout: args.stdout,
        stderr: args.stderr,
      });
    });

  // `source` namespace: source test / source forget.
  const source = program
    .command("source")
    .description("Source-binding operations");

  source
    .command("test <binding-id>")
    .description("Validate a binding's adapter config + credentials")
    .action(async (bindingId: string) => {
      const fn = runners.sourceTest;
      if (fn === undefined) {
        // Default runner needs a registry — tests inject the
        // runner. Production wires a registry in `bin.ts`.
        throw new Error(
          "source test: no registry wired (bin.ts must inject `runners.sourceTest` with the production registry)",
        );
      }
      // Registry is closed over by the bin.ts wrapper; the parse
      // layer passes the registry-less args shape (see runner
      // contract above).
      await fn({
        env: args.env,
        bindingId,
        stdout: args.stdout,
        stderr: args.stderr,
      });
    });

  source
    .command("forget <binding-id>")
    .description(
      "Disable a binding + purge its intake/webhook rows; writes erasure_log",
    )
    .requiredOption(
      "--executor <username>",
      "Gitea username to attribute the erasure to",
    )
    .option("--dry-run", "preview without changing anything", false)
    .action(
      async (
        bindingId: string,
        opts: { executor: string; dryRun?: boolean },
      ) => {
        const fn = runners.sourceForget ?? runSourceForget;
        await fn({
          env: args.env,
          bindingId,
          executor: opts.executor,
          dryRun: opts.dryRun ?? false,
          stdout: args.stdout,
          stderr: args.stderr,
        });
      },
    );

  program
    .command("recompile [selector]")
    .description(
      "Recompile a wiki page (selector: 'domain-slug:page-path') or every page in a domain",
    )
    .requiredOption(
      "--executor <username>",
      "Gitea username to attribute the recompile to",
    )
    .option(
      "--all-in-domain <slug>",
      "recompile every compiled page in <slug>",
    )
    .action(
      async (
        selector: string | undefined,
        opts: { executor: string; allInDomain?: string },
      ) => {
        const fn = runners.recompile ?? runRecompile;
        await fn({
          env: args.env,
          selector: selector ?? null,
          allInDomain: opts.allInDomain ?? null,
          executor: opts.executor,
          stdout: args.stdout,
          stderr: args.stderr,
        });
      },
    );

  // commander.parseAsync handles the whole pipeline; argv is
  // expected NOT to include node + the script path (the bin
  // entry passes `process.argv.slice(2)`).
  await program.parseAsync(args.argv as string[], { from: "user" });
}
