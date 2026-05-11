/**
 * Domain-repo provisioning helper (phase-a appendix #2).
 *
 * # Sanctioned exception (architecture.md §1424, THREAT-MODEL §3.5)
 *
 * Every other Gitea write in opencoo MUST flow through
 * `wikiWrite` (THREAT-MODEL §2 invariant 2). This file is the
 * single sanctioned exception: it provisions a brand-new
 * domain repo. wikiWrite cannot do that — it operates on an
 * existing repo's queue and refuses paths outside the domain's
 * Gitea repo. The exception is scoped to one named function
 * (`provisionDomainRepo`) called exactly once per domain
 * creation, inside the `POST /api/admin/domains` route's
 * provisioning step.
 *
 * The ESLint `opencoo/no-direct-gitea-write` rule allow-lists
 * this file; do not move the function. Future provisioning
 * needs (e.g. a partner Builder-skill overlay repo creation
 * in phase-c) should land alongside this helper, not in a
 * fresh sanctioned exception.
 *
 * # Security pins
 *
 * - **PAT NEVER appears in error.message** — every thrown
 *   error scrubs the PAT bytes via `stripPat`. Mirrors the
 *   gitea-client invariant.
 * - **Authorization header is the PAT's only carrier** — the
 *   PAT is not embedded in URLs, query strings, or commit
 *   messages.
 * - **Idempotent on 409** — re-running provisioning against an
 *   existing repo or pre-seeded file is a no-op, not an error.
 *   Operators can re-run safely after a partial failure.
 *
 * # Failure semantics
 *
 * - 5xx upstream → `GiteaProvisioningUpstreamError` (PAT scrubbed).
 * - network/timeout → `GiteaProvisioningTransientError` (PAT scrubbed).
 * - 401/403 → `GiteaProvisioningUnauthorizedError` (PAT scrubbed).
 * - 409 on the repo-create or any seed file → swallowed, helper
 *   continues (idempotency).
 *
 * The caller (`POST /api/admin/domains`) wraps the call in a
 * DB transaction and ROLLBACKs on any thrown error — fail-closed
 * provisioning means the operator never sees a half-created
 * domain in the database with no Gitea repo.
 */
import { stripPat } from "./gitea-client.js";

/** Domain-class literal — must stay in sync with the
 *  `domains.class` enum in @opencoo/shared/db/schema/enums. */
export type DomainClassForProvisioning =
  | "knowledge"
  | "catalog-workflows"
  | "catalog-skills";

const FETCH_TIMEOUT_MS = 5000;

export class GiteaProvisioningUpstreamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GiteaProvisioningUpstreamError";
    this.status = status;
  }
}

export class GiteaProvisioningUnauthorizedError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GiteaProvisioningUnauthorizedError";
    this.status = status;
  }
}

export class GiteaProvisioningTransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GiteaProvisioningTransientError";
  }
}

export interface ProvisionDomainRepoArgs {
  readonly baseUrl: string;
  /** Caller's Gitea PAT — used for the Authorization header on
   *  every provisioning call. Never persisted; not embedded in
   *  any URL or commit message. Scrubbed from any thrown error. */
  readonly pat: string;
  /** Gitea organisation that will own the new repo. Sourced
   *  from `GITEA_PROVISION_ORG` (default `opencoo`). */
  readonly org: string;
  readonly slug: string;
  readonly domainClass: DomainClassForProvisioning;
  readonly defaultLocale: string;
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface ProvisionDomainRepoResult {
  readonly repoUrl: string;
}

/**
 * Provision a fresh Gitea repo for a new opencoo domain. Steps:
 *   1. POST /api/v1/orgs/{org}/repos — create the repo private.
 *   2. POST /api/v1/repos/{org}/{slug}/contents/index.md     — seed.
 *   3. POST /api/v1/repos/{org}/{slug}/contents/log.md       — seed.
 *   4. POST /api/v1/repos/{org}/{slug}/contents/schema.md    — seed.
 *   5. POST /api/v1/repos/{org}/{slug}/contents/worldview.md — seed
 *      (PR-Z5, closes G4 — phase-a appendix #12).
 *
 * Each seed POST is Gitea's "Create a file" endpoint — it creates
 * the default branch automatically when the repo has no commits,
 * which is the case immediately after step 1. PUT (the "Update a
 * file" endpoint) is never used here: PUT on a fresh empty repo
 * returns 422 [SHA]: Required, which a previous carve-out
 * silently swallowed → empty repo (bug C).
 *
 * The 4th seed (`worldview.md`) is a placeholder body. The
 * worldview compiler (`compile-domain.ts`) IS implemented and
 * tested but has no production caller in phase-a — `wikiWrite`
 * to `worldview.md` from the IngestionProcessor is not yet
 * wired (filed as Z11 / phase-b candidate). Until that lands,
 * the placeholder lives indefinitely. Before Z5, the Heartbeat
 * agent's `worldview://<slug>` MCP resource fetch raised
 * `McpResourceNotFoundError` against any freshly-provisioned
 * domain that had not yet ingested → every Heartbeat dispatch
 * failed with `error_class=validation`. The placeholder closes
 * that gap; locale of the placeholder text follows `defaultLocale`
 * (en/pl supported today; `auto` and unknown locales fall back
 * to en, matching the prompt-loader convention).
 *
 * Returns `{repoUrl}` (Gitea's `html_url` if available, else a
 * deterministic concat of `${baseUrl}/${org}/${slug}`).
 */
export async function provisionDomainRepo(
  args: ProvisionDomainRepoArgs,
): Promise<ProvisionDomainRepoResult> {
  const fetchFn = args.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = args.baseUrl.replace(/\/+$/, "");

  // 1) Create the repo. 409 → already exists, fall through.
  const createBody = {
    name: args.slug,
    private: true,
    auto_init: false,
    description: `opencoo domain: ${args.slug} (${args.domainClass})`,
  };
  const createUrl = `${baseUrl}/api/v1/orgs/${encodeURIComponent(args.org)}/repos`;
  const createRes = await callGitea(
    fetchFn,
    createUrl,
    args.pat,
    "POST",
    JSON.stringify(createBody),
  );

  let repoUrl = `${baseUrl}/${args.org}/${args.slug}`;
  if (createRes.status !== 409) {
    const json = (await safeJson(createRes, args.pat)) as {
      html_url?: unknown;
    };
    if (typeof json.html_url === "string" && json.html_url.length > 0) {
      repoUrl = json.html_url;
    }
  }

  // 2-5) Seed four files. Each POST is idempotent on the
  //      already-provisioned signal: callGitea swallows 409 by
  //      returning the Response untouched (race between two
  //      provisioning calls or re-running against an already-
  //      seeded repo), and below we additionally swallow the
  //      422 + "already exists" body Gitea returns when the
  //      target path is occupied. The previous code used PUT
  //      and matched 422 [SHA]: Required, which silently
  //      swallowed the empty-repo failure mode (PUT on a fresh
  //      repo always returns 422 SHA-required) → empty repo.
  //      Now POST creates the file and the default branch
  //      atomically, so the "fresh repo" case is the success
  //      path, not an error.
  //
  //      The 4th seed (worldview.md) is the PR-Z5 placeholder
  //      that closes G4 — see the function-level docstring above.
  const seeds = buildSeedFiles({
    slug: args.slug,
    domainClass: args.domainClass,
    defaultLocale: args.defaultLocale,
  });
  for (const file of seeds) {
    const fileUrl =
      `${baseUrl}/api/v1/repos/${encodeURIComponent(args.org)}` +
      `/${encodeURIComponent(args.slug)}/contents/${encodeURIComponent(file.path)}`;
    const seedBody = {
      message: file.commitMessage,
      content: Buffer.from(file.content, "utf8").toString("base64"),
    };
    // 409 ("file already exists") doesn't throw — `callGitea`
    // returns the Response directly on 409 (line ~273); inline
    // check is the only place 409 can be observed.
    let seedRes;
    try {
      seedRes = await callGitea(fetchFn, fileUrl, args.pat, "POST", JSON.stringify(seedBody));
    } catch (err) {
      // Idempotency: 422 with body matching /already exists/i is
      // "already provisioned, skip". Matching /already exists/
      // rather than a specific Gitea phrasing defends against
      // i18n / wording drift. A 422 with any OTHER body (including
      // the legacy [SHA]: Required) MUST propagate — that was the
      // bug-C failure mode and the negative regression test pins it.
      if (
        err instanceof GiteaProvisioningUpstreamError &&
        err.status === 422 &&
        /already exists/i.test(err.message)
      ) {
        continue;
      }
      throw err;
    }
    if (seedRes.status === 409) continue;
  }

  return { repoUrl };
}

interface SeedFile {
  readonly path: string;
  readonly content: string;
  /** Commit message for the Gitea "Create a file" call. The
   *  first three seeds share the legacy `[provisioning] seed
   *  <path>` shape; PR-Z5's `worldview.md` uses the more
   *  explicit `seed: empty worldview placeholder` so a partner
   *  inspecting `git log` immediately sees the file's purpose. */
  readonly commitMessage: string;
}

interface SeedArgs {
  readonly slug: string;
  readonly domainClass: DomainClassForProvisioning;
  readonly defaultLocale: string;
}

function buildSeedFiles(args: SeedArgs): readonly SeedFile[] {
  const isCatalog =
    args.domainClass === "catalog-workflows" ||
    args.domainClass === "catalog-skills";
  const indexHeader = isCatalog
    ? `# ${args.slug} catalog\n\nClass: \`${args.domainClass}\` · locale: \`${args.defaultLocale}\`\n\nThis catalog domain holds entries compiled from a SourceAdapter into the catalog template (architecture §6.3.1).\n`
    : `# ${args.slug}\n\nClass: \`${args.domainClass}\` · locale: \`${args.defaultLocale}\`\n\nThis is a freshly provisioned opencoo domain. Pages will be compiled here as the Ingestion pipelines run.\n`;
  return [
    {
      path: "index.md",
      content: indexHeader,
      commitMessage: "[provisioning] seed index.md",
    },
    {
      path: "log.md",
      content: `# Activity log\n\nAppend-only event log. Maintained automatically by opencoo.\n`,
      commitMessage: "[provisioning] seed log.md",
    },
    {
      path: "schema.md",
      content: `# Schema\n\nDomain class: \`${args.domainClass}\`. Locale: \`${args.defaultLocale}\`. Provisioning seeded on first creation.\n`,
      commitMessage: "[provisioning] seed schema.md",
    },
    {
      // PR-Z5 (phase-a appendix #12) — closes G4. Heartbeat
      // reads `worldview://<slug>` via gitea-wiki-mcp-server; a
      // missing file raises `McpResourceNotFoundError`. Seed an
      // empty-but-valid placeholder so Heartbeat succeeds on a
      // freshly provisioned domain. NOTE: the worldview compiler
      // (`pipelines/worldview/compile-domain.ts`) is implemented
      // but has no production caller in phase-a; the placeholder
      // lives until Z11 / phase-b wires the IngestionProcessor →
      // `wikiWrite('worldview.md')` aggregator.
      path: "worldview.md",
      content: buildWorldviewPlaceholder(args.defaultLocale),
      commitMessage: "seed: empty worldview placeholder",
    },
  ];
}

/**
 * Locale-specific placeholder body for `worldview.md`. Bundled
 * inline (not loaded from `packages/shared/src/prompts/*`) because
 * the provisioning helper is the single sanctioned wikiWrite
 * exception (architecture.md §1424) and must not depend on the
 * prompt-loader registry — provisioning runs before any LLM
 * scaffold is wired and must succeed in a stripped-down composition.
 *
 * `auto` and any unknown locale fall back to English, matching
 * the prompt-loader convention (§7 in `packages/shared/src/
 * prompts/loader.ts`).
 */
export function buildWorldviewPlaceholder(locale: string): string {
  if (locale === "pl") {
    return [
      "# Worldview domeny",
      "",
      "_Kompilowane z treści źródłowych. Oczekiwanie na pierwszą synchronizację._",
      "",
      "Ten plik to synteza wątków przekrojowych, powtarzających się tematów i znanych operatorowi ograniczeń wyprowadzonych z dokumentów źródłowych domeny. Jest regenerowany przy każdym udanym cyklu synchronizacji przez Worldview Compiler (architecture.md §9).",
      "",
      "Do czasu pierwszej synchronizacji źródła i uruchomienia kompilatora, ten placeholder stanowi worldview widoczny dla agentów Heartbeat / Lint / Surfacer.",
      "",
    ].join("\n");
  }
  // en (default), auto, and any unknown locale.
  return [
    "# Domain Worldview",
    "",
    "_Compiled from source content. Awaiting first ingest._",
    "",
    "This file is a synthesis of cross-cutting facts, recurring themes, and operator-known constraints derived from the domain's source documents. It's regenerated on every successful ingest cycle by the Worldview Compiler (architecture.md §9).",
    "",
    "Until the first source binding has ingested at least one document and the compiler runs, this placeholder serves as the worldview the Heartbeat / Lint / Surfacer agents see.",
    "",
  ].join("\n");
}

/**
 * Wrapped fetch that:
 *   - sets `Authorization: token <pat>` (Gitea convention),
 *   - sets `content-type: application/json` for body-bearing methods,
 *   - 5-sec abort timeout (admin provisioning must not hang),
 *   - throws on non-2xx WITHOUT including PAT bytes; 409 returns
 *     the response so the caller can detect idempotent reuse.
 */
async function callGitea(
  fetchFn: typeof fetch,
  url: string,
  pat: string,
  method: "GET" | "POST",
  body: string | undefined,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `token ${pat}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...(body !== undefined ? { body } : {}),
  };

  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new GiteaProvisioningTransientError(
      `gitea provisioning ${method} ${url} failed (${stripPat(cause, pat)})`,
      { cause: err },
    );
  }

  // 409 = already exists. Caller treats this as idempotent reuse.
  if (res.status === 409) return res;

  if (!res.ok) {
    const bodyText = await res
      .text()
      .then((s) => s.slice(0, 200))
      .catch(() => "");
    const scrubbed = stripPat(bodyText, pat);
    if (res.status === 401 || res.status === 403) {
      throw new GiteaProvisioningUnauthorizedError(
        res.status,
        `gitea provisioning ${method} ${url} returned ${res.status}: ${scrubbed}`,
      );
    }
    throw new GiteaProvisioningUpstreamError(
      res.status,
      `gitea provisioning ${method} ${url} returned ${res.status}: ${scrubbed}`,
    );
  }

  return res;
}

async function safeJson(res: Response, pat: string): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GiteaProvisioningUpstreamError(
      res.status,
      `gitea provisioning: invalid JSON (status ${res.status}, ${text.length} bytes, scrubbed='${stripPat(text.slice(0, 80), pat)}')`,
    );
  }
}
