export * from "./brands.js";
export * as schema from "./schema/index.js";
export * from "./inserts.js";
// JSONB-payload types (ToolCall, InstanceMemory, etc.) — engines
// consume these alongside the table schemas they decorate.
export * from "./types/index.js";
// Shared content-kind enum + catalog-workflow fence info-string
// (PR 26 / plan #122 — source-drive + source-n8n single source of
// truth).
export * from "./content-kind.js";
// Auto-migrate helper (PR-X1, phase-a follow-up). Used by both
// the CLI `opencoo migrate` verb AND engine-self-operating's
// boot path so the migration entry point is exactly one
// function across the codebase.
export {
  AUTO_MIGRATE_LOCK_KEY_SQL,
  AUTO_MIGRATE_LOCK_LABEL,
  applyMigrationsWithLock,
  resolveSharedMigrationsDir,
  type ApplyMigrationsWithLockArgs,
} from "./auto-migrate.js";
