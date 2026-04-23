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

## Migrations

`drizzle-kit generate` is idempotent — `tests/generate-idempotent.test.ts` asserts this by running it twice into temp dirs and byte-diffing the outputs (with volatile `when`/`id` fields normalized). A regression means the schema code has picked up nondeterminism — investigate and fix, do not delete the test.

Scripts:

- `pnpm --filter @opencoo/shared db:generate [--name <label>]` — emit a new migration.
- `pnpm --filter @opencoo/shared db:check` — drift-check the generated SQL against the schema snapshot.

Runtime migration (`drizzle-kit migrate` / a `migrator` script) lands with engine boot in PR 06.
