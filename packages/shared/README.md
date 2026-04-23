# @opencoo/shared

Shared kernel for the opencoo monorepo.

## Schema ownership

**This package is the single source of truth for every `pgTable` in the monorepo.** No other package declares database tables (CLAUDE.md "load-bearing architectural decisions"). Engines, adapters, CLI, and UI all import schema from `@opencoo/shared/db/schema`.

### Adding a table

1. Create `src/db/schema/<new-table>.ts` with the `pgTable` declaration.
2. Append `export * from "./<new-table>.js";` to `src/db/schema/index.ts`. Keep this list alphabetized — drizzle's schema glob reads files in alphabetical order, and FK targets must appear before FK sources (e.g. `credentials.ts` before `sources-bindings.ts`).
3. Add a matching block to `tests/schema.test.ts` — column names, SQL types, nullability, defaults, FK targets, indexes.
4. Run `pnpm --filter @opencoo/shared test` → Red. Then run `pnpm --filter @opencoo/shared db:generate --name <short-label>` to produce the migration.
5. Re-run tests → Green; commit in test-before-impl order.

### Adding a column to an existing table

Extend the `pgTable` body, add/update tests, then `db:generate --name <label>`. Never hand-edit existing `drizzle/*.sql` files — always generate.

### Adding a value to a `pgEnum`

Cheap migration. Append to the `pgEnum(...)` tuple and generate. **Renaming** an enum value (or the enum itself) is expensive — it requires an explicit `ALTER TYPE` that the Drizzle differ won't emit. Plan renames as a dedicated PR.

## Identity

### Server-generated UUIDs

Every table uses `uuid("id").primaryKey().default(sql\`gen_random_uuid()\`)`. `gen_random_uuid()` is in PostgreSQL core since **PG 13** — the reference docker image pins PG 16, so no `CREATE EXTENSION pgcrypto` line is required. **Write paths must not specify `id`** unless rotating a credential or recreating a purged row; let the DB generate it.

### Branded ID types

```ts
import type { DomainId, SourceBindingId, UserId, CredentialId } from "@opencoo/shared/db";
```

These are `string` subtypes tagged with a unique symbol brand. The TypeScript compiler rejects a call like `getDomain(someUserId)` at the type level.

Construction goes through a validator (Zod at the boundary, per CONVENTIONS §2.1) — you do not cast. When reading from Drizzle the column is typed `string`; narrow to the brand at the repo/DAO layer (PR 13 onward).

## Insert helpers

`exactOptionalPropertyTypes` + Drizzle's inferred `InsertModel` disagree on the shape of optional columns: Drizzle wants the key *absent*, the strict mode rejects `undefined`-valued keys. The `stripUndefined()` helper in `src/db/inserts.ts` is a thin filter you pass through at the insert call site:

```ts
import { stripUndefined } from "@opencoo/shared/db";
await db.insert(domains).values(stripUndefined({ slug, name, retentionDays }));
```

## `$onUpdate` is app-side only

`updated_at` is wired with `.$onUpdate(() => new Date())`. This is a **Drizzle-side hook** — a raw `UPDATE domains SET …` via `sql\`\`` or psql does **not** trigger it. v0.1 relies on the invariant that every write goes through the typed Drizzle query builder. If a future feature needs DB-side enforcement, add a trigger in a new migration — don't expect the `$onUpdate` hook to fire for SQL that bypasses the builder.

## Append-only invariant (THREAT-MODEL §2 invariant 8)

Certain tables must never grow an `updated_at` column because their *purpose* is the permanent audit trail — rewriting a past row would falsify the record. The current set:

- `page_citations` — per-page provenance ledger (which source compiled which page, when).
- `redaction_events` — one row per guard-triggered redaction, metadata only (§3.3).
- `erasure_log` — one row per admin-triggered erasure verb (§15).
- `miner_suppressions` — operator "don't propose this again" decisions.
- `agent_runs` — one row per agent harness invocation (architecture §7.1); `started_at`/`ended_at` are the run's open/close markers, not mutation history.

These tables have no `updated_at`, no `$onUpdate`, and no mutation-path writes from engine code. The only DELETE source is retention pruning in the Cleanup pipeline.

### Two lines of enforcement

1. **Schema-level** — `packages/shared/tests/append-only-invariant.test.ts` introspects each table via `getTableConfig()` and fails CI if any sneaks in an `updated_at`, `modified_at`, `edited_at`, or other `*_at` column that isn't in the allow-list (`created_at`, plus `started_at`/`ended_at` on `agent_runs`).
2. **Query-level** — `opencoo/no-update-append-only` (ESLint) rejects `db.update(tbl)` and `db.delete(tbl)` calls where `tbl` is in the hard-coded set of append-only table symbols. Handles chain forms like `db.with(cte).update(pageCitations)`. See the rule file's top-of-file comment for the "how to add a table" pointer — append the Drizzle symbol name to `TABLES` there AND to `APPEND_ONLY_TABLES` in the test AND to the §2 invariant-8 list in `THREAT-MODEL.md`.

## Mutation-adjacent tables

Some tables carry a state machine we *do* update in place — notably `catalog_candidate`, whose `status` transitions `detected` → `drafted` → `reviewing` → `approved`/`rejected` → `promoted` as reviewers move it through the Review Dashboard. `reviewed_by` + `reviewed_at` populate alongside. This is a sanctioned UPDATE path and is explicitly carved out of §2 invariant 8 in THREAT-MODEL.md.

Mutation-adjacent tables keep `updated_at` (via the shared `updatedAt()` helper) and behave like normal CRUD rows. They do NOT appear in the append-only invariant test.

## Logger

`@opencoo/shared/logger` exposes a `ConsoleLogger` + `Logger` interface + `loggerFromEnv()` factory. One JSON object per call, terminated by `\n` — downstream collectors split on newline. Four levels (`debug` | `info` | `warn` | `error`) with threshold filtering, and `child(ctx)` for layering request-scoped context without mutating the parent. `loggerFromEnv` reads `LOG_LEVEL` and falls back to `info` on unknown/empty values.

```ts
import { loggerFromEnv } from "@opencoo/shared/logger";

const log = loggerFromEnv();
log.info("pipeline started", { pipeline: "ingestion-scanner" });
const run = log.child({ runId: "r-abc" });
run.warn("upstream slow", { latencyMs: 4500 });
```

Stream and clock are test seams — `new ConsoleLogger({ stream, now })` captures output into an array and pins `ts`. Use these in tests, never `console.log`.

### Invariant 11 callout

The logger does **not** filter raw prompts/responses at runtime. THREAT-MODEL §2 invariant 11 ("never log raw prompts at `info`") is a code-review gate, not a firewall. Prompts + responses go through the `llm_usage_debug` table (PR 07 llm-router), not `logger.info`. If a reviewer sees prompt bytes reaching `logger.info`/`warn`/`error`, that's a ship-blocker.

## Errors

`@opencoo/shared/errors` defines the three-class taxonomy from CONVENTIONS §2.4: `ValidationError` (→ immediate DLQ), `TransientError` (→ linear backoff), `UpstreamQuotaError` (→ exponential backoff). All three extend `OpencooError`, which stores a `readonly errorClass: ErrorClass` discriminant and chains `Error.cause` through an options object.

```ts
import { ValidationError, isOpencooError } from "@opencoo/shared/errors";

try {
  schema.parse(input);
} catch (zodError) {
  throw new ValidationError("field missing", { cause: zodError });
}

// downstream retry:
if (isOpencooError(err)) {
  switch (err.errorClass) {
    case "validation":     /* no retry */ break;
    case "transient":      /* linear backoff */ break;
    case "upstream-quota": /* exponential backoff */ break;
  }
}
```

The `cause` argument is routed through a ternary internally so `super(msg, { cause: undefined })` — a type error under `exactOptionalPropertyTypes` — never fires.

## Migrations

`drizzle-kit generate` is idempotent — `tests/generate-idempotent.test.ts` asserts this by running it twice into temp dirs and byte-diffing the outputs (with volatile `when`/`id` fields normalized). A regression means the schema code has picked up nondeterminism — investigate and fix, do not delete the test.

Scripts:

- `pnpm --filter @opencoo/shared db:generate [--name <label>]` — emit a new migration.
- `pnpm --filter @opencoo/shared db:check` — drift-check the generated SQL against the schema snapshot.

Runtime migration (`drizzle-kit migrate` / a `migrator` script) lands with engine boot in PR 06.
