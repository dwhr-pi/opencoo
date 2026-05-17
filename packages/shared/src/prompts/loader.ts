/**
 * Prompt loader. Pure synchronous lookup against an inlined
 * registry — no filesystem I/O at runtime so the loader is safe
 * to call from any context (workers, scheduled jobs, request
 * handlers).
 *
 * Locale fallback (per Q7): `auto` → `en`, unknown → `en`. Both
 * surface as `fallbackApplied: true` so callers (engine harness,
 * audit log) can record the fallback at their preferred level
 * without the loader making logging assumptions.
 *
 * The PROMPT_NAMES / PROMPT_LOCALES tuples are the single source
 * of truth for what the loader supports — adding a new prompt
 * requires extending both the tuple AND the inlined registry, so
 * a stale entry in only one half fails type-check.
 *
 * PR-W1 (phase-a appendix #15) adds the asynchronous
 * `loadPromptForScope` overload that reads `prompt_overrides`
 * with `instance > domain > baseline` precedence. The
 * synchronous `loadPrompt` signature is unchanged — the
 * injection-corpus runner is version-pinned to shipped
 * baselines and explicitly bypasses the override path.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  CLASSIFIER_PROMPT_VERSION,
  EN_CLASSIFIER_PROMPT,
} from "./en-classifier.js";
import { PL_CLASSIFIER_PROMPT } from "./pl-classifier.js";
import {
  COMPILER_PROMPT_VERSION,
  EN_COMPILER_PROMPT,
} from "./en-compiler.js";
import { PL_COMPILER_PROMPT } from "./pl-compiler.js";
import {
  EN_HEARTBEAT_PROMPT,
  HEARTBEAT_PROMPT_VERSION,
} from "./en-heartbeat.js";
import { PL_HEARTBEAT_PROMPT } from "./pl-heartbeat.js";
import {
  EN_LINT_PROMPT,
  LINT_PROMPT_VERSION,
} from "./en-lint.js";
import { PL_LINT_PROMPT } from "./pl-lint.js";
import {
  CHAT_PROMPT_VERSION,
  EN_CHAT_PROMPT,
} from "./en-chat.js";
import { PL_CHAT_PROMPT } from "./pl-chat.js";
import {
  EN_SURFACER_PROMPT,
  SURFACER_PROMPT_VERSION,
} from "./en-surfacer.js";
import { PL_SURFACER_PROMPT } from "./pl-surfacer.js";
import {
  BUILDER_PROMPT_VERSION,
  EN_BUILDER_PROMPT,
} from "./en-builder.js";
import { PL_BUILDER_PROMPT } from "./pl-builder.js";
import {
  EN_WORLDVIEW_DOMAIN_PROMPT,
  WORLDVIEW_DOMAIN_PROMPT_VERSION,
} from "./en-worldview-domain.js";
import { PL_WORLDVIEW_DOMAIN_PROMPT } from "./pl-worldview-domain.js";
import {
  EN_WORLDVIEW_COMPANY_PROMPT,
  WORLDVIEW_COMPANY_PROMPT_VERSION,
} from "./en-worldview-company.js";
import { PL_WORLDVIEW_COMPANY_PROMPT } from "./pl-worldview-company.js";

export const PROMPT_NAMES = [
  "classifier",
  "compiler",
  "heartbeat",
  "lint",
  "chat",
  "surfacer",
  "builder",
  "worldview-domain",
  "worldview-company",
] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export const PROMPT_LOCALES = ["en", "pl", "auto"] as const;
export type PromptLocale = (typeof PROMPT_LOCALES)[number];

/**
 * Inlined registry — locale × name → prompt body. Adding a new
 * (locale, name) pair requires touching this map AND the source
 * .ts module that exports the body string. Keeping the lookup
 * pure-function lets us avoid build-time copy of .md files into
 * dist/ (which tsc doesn't do natively).
 */
const REGISTRY: {
  readonly [L in Exclude<PromptLocale, "auto">]: {
    readonly [N in PromptName]: string;
  };
} = {
  en: {
    classifier: EN_CLASSIFIER_PROMPT,
    compiler: EN_COMPILER_PROMPT,
    heartbeat: EN_HEARTBEAT_PROMPT,
    lint: EN_LINT_PROMPT,
    chat: EN_CHAT_PROMPT,
    surfacer: EN_SURFACER_PROMPT,
    builder: EN_BUILDER_PROMPT,
    "worldview-domain": EN_WORLDVIEW_DOMAIN_PROMPT,
    "worldview-company": EN_WORLDVIEW_COMPANY_PROMPT,
  },
  pl: {
    classifier: PL_CLASSIFIER_PROMPT,
    compiler: PL_COMPILER_PROMPT,
    heartbeat: PL_HEARTBEAT_PROMPT,
    lint: PL_LINT_PROMPT,
    chat: PL_CHAT_PROMPT,
    surfacer: PL_SURFACER_PROMPT,
    builder: PL_BUILDER_PROMPT,
    "worldview-domain": PL_WORLDVIEW_DOMAIN_PROMPT,
    "worldview-company": PL_WORLDVIEW_COMPANY_PROMPT,
  },
};

/**
 * Version registry — one VERSION per prompt NAME (not per locale).
 * EN and PL move in lockstep so this map is locale-free; the
 * loader exposes the value through `LoadedPrompt.version`. The
 * compiler writes it into `page_citations.prompt_version` so a
 * stale-output bug can be triaged by querying which version
 * produced which page.
 */
const VERSIONS: { readonly [N in PromptName]: string } = {
  classifier: CLASSIFIER_PROMPT_VERSION,
  compiler: COMPILER_PROMPT_VERSION,
  heartbeat: HEARTBEAT_PROMPT_VERSION,
  lint: LINT_PROMPT_VERSION,
  chat: CHAT_PROMPT_VERSION,
  surfacer: SURFACER_PROMPT_VERSION,
  builder: BUILDER_PROMPT_VERSION,
  "worldview-domain": WORLDVIEW_DOMAIN_PROMPT_VERSION,
  "worldview-company": WORLDVIEW_COMPANY_PROMPT_VERSION,
};

export interface LoadPromptArgs {
  readonly name: PromptName;
  readonly locale: PromptLocale;
}

export interface LoadedPrompt {
  readonly name: PromptName;
  /** Effective locale after fallback resolution — never `auto`,
   *  always `en` or `pl`. */
  readonly locale: Exclude<PromptLocale, "auto">;
  readonly body: string;
  /** Semver-shaped string identifying this prompt revision.
   *  Persisted by the compiler into `page_citations.prompt_version`
   *  so a stale-output bug can be triaged by querying which version
   *  produced which page. EN and PL of the same name share one
   *  version. */
  readonly version: string;
  /** True when the requested locale was `auto` or an unknown
   *  string and we fell back to `en`. The caller logs this at
   *  whatever level it deems appropriate (warn for production,
   *  debug for tests). */
  readonly fallbackApplied: boolean;
}

const KNOWN_CONCRETE_LOCALES = new Set<string>(["en", "pl"]);

export function loadPrompt(args: LoadPromptArgs): LoadedPrompt {
  const requested = args.locale;
  const fallbackApplied = requested === "auto" || !KNOWN_CONCRETE_LOCALES.has(requested);
  const effective: Exclude<PromptLocale, "auto"> = fallbackApplied
    ? "en"
    : (requested as Exclude<PromptLocale, "auto">);
  return {
    name: args.name,
    locale: effective,
    body: REGISTRY[effective][args.name],
    version: VERSIONS[args.name],
    fallbackApplied,
  };
}

// ---------------------------------------------------------------------------
// PR-W1 (phase-a appendix #15) — per-(domain, instance) override resolver.
// ---------------------------------------------------------------------------

/**
 * Loose Drizzle handle accepted by `loadPromptForScope`. Mirrors
 * the `Db` shape every engine module already passes around
 * (`PgDatabase<PgQueryResultHKT, Record<string, unknown>>`) so
 * existing call-site rewrites can pass their existing `db`
 * handle without an adapter.
 */
export type ScopeResolverDb = PgDatabase<
  PgQueryResultHKT,
  Record<string, unknown>
>;

/**
 * Args for `loadPromptForScope`. `instanceId` is optional —
 * scheduled callers that don't have a per-instance scope (e.g.
 * one-off scripts or v2+ background jobs) MAY omit it and get
 * the next-most-specific scope (domain row → baseline).
 *
 * `db` is whatever Drizzle pg-core handle the caller already
 * has. The resolver issues exactly ONE SELECT.
 */
export interface LoadPromptForScopeArgs {
  readonly name: PromptName;
  readonly locale: PromptLocale;
  readonly domainId: string;
  readonly instanceId?: string;
  readonly db: ScopeResolverDb;
}

/**
 * Structured override metadata. `scope` records which row the
 * resolver matched (so the page-citations writer can persist
 * `overridesVersion` and the admin UI can render "instance" /
 * "domain" badges). `isStale` is the `(baseline_version
 * stored_at_apply !== current_shipped_version)` predicate the
 * UI's lagging-overrides banner consumes.
 */
export interface PromptOverrideRef {
  readonly scope: "instance" | "domain";
  readonly overridesVersion: string;
  readonly baselineVersion: string;
  readonly isStale: boolean;
}

/**
 * The async-path return shape. Adds the `override` field
 * alongside every field on `LoadedPrompt`. `override === null`
 * when the resolver fell through to the shipped baseline; the
 * page-citations writer's contract is:
 *
 *   prompt_version := override?.overridesVersion ?? baseline.version
 *
 * which is also persisted into `page_citations.prompt_version`
 * by the compiler so a stale-output bug can be triaged to the
 * exact (override, baseline) pair that produced it.
 */
export interface LoadedPromptWithOverride extends LoadedPrompt {
  readonly override: PromptOverrideRef | null;
}

interface PromptOverrideRow {
  readonly body: string;
  readonly overrides_version: string;
  readonly baseline_version: string;
  readonly is_instance_scoped: boolean;
}

interface ExecResult<R> {
  readonly rows: R[];
}

/**
 * Asynchronous, scope-aware loader. Reads `prompt_overrides`
 * once with `instance > domain > baseline` precedence and
 * returns the effective prompt body. Always returns — the
 * shipped baseline is the terminal fallback so this function
 * never throws on "no row found".
 *
 * Precedence is enforced in the SQL by `ORDER BY instance_id
 * NULLS LAST LIMIT 1`: when both a domain-scoped (NULL
 * instance_id) and an instance-scoped row match the filter, the
 * instance row sorts first and wins. When the caller didn't
 * pass `instanceId` the `instance_id IS NULL` half of the OR
 * clause selects only the domain row.
 *
 * SCOPE NOTE: the resolver does NOT enforce caller-scope
 * itself. The agent harness's `assertDomainSlugInScope`
 * (`engine-self-operating/src/agents/scope-check.ts`) is the
 * authoritative runtime check that the `domainId` belongs to a
 * domain in the caller's scope. The resolver trusts the caller
 * because (a) every v0.1 call site is downstream of that
 * harness check, and (b) duplicating the check here would
 * couple `@opencoo/shared` to the agent harness.
 *
 * UUID-FORMAT NOTE: `domainId` / `instanceId` are interpolated
 * into a `::uuid` cast via Drizzle's parameterised template (so
 * SQL injection is impossible), but malformed values surface as
 * a Postgres `invalid input syntax for type uuid` error. The
 * resolver does NOT pre-validate — every v0.1 caller obtains
 * these from already-validated DB rows or admin-API surfaces
 * (UUID-validated before cast per `domains-llm-policy.ts`
 * pattern). A future caller path that doesn't share that
 * upstream validation should validate before calling.
 *
 * PERF NOTE: the resolver issues one indexed SELECT per call.
 * In hot paths (classifier / merge-page run per ingested doc;
 * agents run once per scheduled tick) this is an extra DB
 * roundtrip even when no override exists. The UNIQUE index on
 * `(domain_id, instance_id, prompt_name, locale)` keeps the
 * lookup O(log n), and on PGlite-fast Postgres the empty-case
 * is sub-millisecond. A domain-scoped LRU is a v0.2 candidate
 * once we have measurements showing the overhead is material.
 */
export async function loadPromptForScope(
  args: LoadPromptForScopeArgs,
): Promise<LoadedPromptWithOverride> {
  const baseline = loadPrompt({ name: args.name, locale: args.locale });

  // The SELECT predicate covers both shapes in one query:
  //   - instance-scoped row (instance_id = caller's instanceId)
  //   - domain-scoped row (instance_id IS NULL)
  //
  // `ORDER BY instance_id NULLS LAST LIMIT 1` picks the
  // instance row when both exist. `is_instance_scoped` is
  // computed in SQL so the JS branch on `scope` is a pure
  // boolean check (avoids re-comparing UUIDs).
  //
  // The locale used for the SELECT is the EFFECTIVE locale
  // after fallback (baseline.locale), not the requested one —
  // a caller asking for `locale='auto'` resolves against the
  // 'en' row, matching how the baseline body itself is
  // selected. This keeps the override path consistent with
  // the synchronous baseline path; storing an 'auto' row is
  // already forbidden by the CHECK constraint.
  const result = (await args.db.execute(sql`
    SELECT
      body,
      overrides_version,
      baseline_version,
      (instance_id IS NOT NULL) AS is_instance_scoped
    FROM prompt_overrides
    WHERE prompt_name = ${args.name}
      AND locale = ${baseline.locale}
      AND domain_id = ${args.domainId}::uuid
      AND (
        instance_id IS NULL
        ${args.instanceId !== undefined ? sql`OR instance_id = ${args.instanceId}::uuid` : sql``}
      )
    ORDER BY instance_id NULLS LAST
    LIMIT 1
  `)) as unknown as ExecResult<PromptOverrideRow>;

  const row = result.rows[0];
  if (row === undefined) {
    return { ...baseline, override: null };
  }

  const overridesVersion = row.overrides_version;
  const storedBaselineVersion = row.baseline_version;
  const currentBaselineVersion = baseline.version;
  const isStale = storedBaselineVersion !== currentBaselineVersion;

  return {
    name: args.name,
    locale: baseline.locale,
    body: row.body,
    // Per the page-citations contract: prompt_version on
    // override-active runs is the override's semver, not the
    // shipped baseline's. The writer reads
    // `result.override?.overridesVersion ?? result.version`
    // so this field stays the SHIPPED version for triage
    // continuity (`isStale` tells the UI when they diverge).
    version: currentBaselineVersion,
    fallbackApplied: baseline.fallbackApplied,
    override: {
      scope: row.is_instance_scoped ? "instance" : "domain",
      overridesVersion,
      baselineVersion: storedBaselineVersion,
      isStale,
    },
  };
}
