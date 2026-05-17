/**
 * `prompt_overrides` — operator-managed per-(domain, instance,
 * prompt, locale) overrides of the shipped baseline prompts
 * (PR-W1, phase-a appendix #15).
 *
 * One row per active override. Runtime resolution is
 * `instance > domain > shipped baseline` (see `loadPromptForScope`
 * in `packages/shared/src/prompts/loader.ts`).
 *
 * Schema shape:
 *   - `domain_id`         — FK → `domains(id) ON DELETE CASCADE`.
 *     Every override belongs to a domain. For instance-scoped
 *     rows the admin-API (W2) writes the instance's primary
 *     scope domain (`agent_instances.scope_domain_ids[0]`); the
 *     schema itself does NOT enforce that match — adding a
 *     CHECK against an array element would require a trigger or
 *     stored procedure. W2 is the authoritative writer; direct
 *     SQL bypassing the admin-API can drift this and the
 *     resolver will surface whichever row matches the filter.
 *   - `instance_id`       — FK → `agent_instances(id) ON DELETE
 *     CASCADE`, NULLABLE. When NULL the row is a domain-scoped
 *     override.
 *   - `prompt_name`       — one of the PROMPT_NAMES tuple
 *     (text + CHECK).
 *   - `locale`            — `en` or `pl` (text + CHECK; `auto`
 *     resolves to `en` at load time, never persisted).
 *   - `body`              — the override prompt text. Capped at
 *     100 KB at the DB layer via CHECK so a runaway operator
 *     paste cannot blow up the rendered prompt at the LLM call
 *     site (defense in depth against a future route bypass —
 *     admin-API routes also pre-validate via Zod).
 *   - `overrides_version` — semver, bumped on every apply.
 *     Persisted into `page_citations.prompt_version` instead of
 *     the shipped baseline version when an override is active.
 *   - `baseline_version`  — the shipped `*_PROMPT_VERSION` at
 *     apply-time. Drives the lagging-overrides banner
 *     (`isStale = baseline_version !== current_shipped_version`).
 *
 * Uniqueness with `NULLS NOT DISTINCT`: `(domain_id, instance_id,
 * prompt_name, locale)` must be unique INCLUDING when
 * `instance_id IS NULL`. This lets a single domain-scoped row
 * coexist with multiple instance-scoped rows for the same
 * `(domain, prompt, locale)` — NULL is treated as a distinct
 * value, not a wildcard. Postgres 15+ supports
 * `NULLS NOT DISTINCT` on UNIQUE constraints directly; the
 * engine's `compose.yml` pins Postgres 16-alpine, so the
 * constraint expresses the invariant in-database.
 *
 * THREAT-MODEL alignment:
 *   - §3.5 admin trust class: `body` reaches the LLM verbatim —
 *     same trust class as `domains.llm_policy.system_prompt`.
 *     The admin-API mutation routes (W2) gate with CSRF +
 *     admin-team + audit-write-before-mutate. The CHECK on
 *     length here is defense in depth.
 *   - §3.5 sovereignty: the resolver reads ONLY rows in the
 *     caller's scope (the agent harness's `assertDomainSlugInScope`
 *     at run-start is the runtime check; the schema does not
 *     gate this).
 *   - §3.3 append-only: this is a state-machine table (UPSERT on
 *     apply), NOT an append-only log. The audit trail lives in
 *     `admin_audit_log` with verbs `prompt_override.apply` /
 *     `prompt_override.delete` added in W2.
 *
 * Adding a new prompt name to the PROMPT_NAMES tuple requires a
 * follow-up migration to ALTER TABLE DROP CONSTRAINT / ADD
 * CONSTRAINT with the new list — the CHECK is inlined in the
 * migration SQL and frozen at apply-time. The lockstep test
 * (`prompt-overrides-schema.test.ts` last suite) catches the
 * drift at CI time so a missing follow-up migration cannot
 * silently ship.
 */
import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, primaryKeyId, updatedAt } from "./columns.js";
import { agentInstances } from "./agent-instances.js";
import { domains } from "./domains.js";
import { users } from "./users.js";

export const promptOverrides = pgTable(
  "prompt_overrides",
  {
    id: primaryKeyId(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id").references(() => agentInstances.id, {
      onDelete: "cascade",
    }),
    promptName: text("prompt_name").notNull(),
    locale: text("locale").notNull(),
    body: text("body").notNull(),
    overridesVersion: text("overrides_version").notNull(),
    baselineVersion: text("baseline_version").notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "prompt_overrides_locale_allowed",
      sql`${t.locale} IN ('en', 'pl')`,
    ),
    check(
      "prompt_overrides_body_len",
      sql`length(${t.body}) <= 100000`,
    ),
    check(
      "prompt_overrides_prompt_name_allowed",
      sql`${t.promptName} IN ('classifier','compiler','heartbeat','lint','chat','surfacer','builder','worldview-domain','worldview-company')`,
    ),
    unique("prompt_overrides_scope_unique")
      .on(t.domainId, t.instanceId, t.promptName, t.locale)
      .nullsNotDistinct(),
  ],
);
