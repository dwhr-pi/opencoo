/**
 * AsanaClient — REST client for Asana task-list fetches (PR-G).
 *
 * Fetches project task snapshots via Asana REST API:
 *   GET /projects/{projectGid}/tasks?opt_fields=...&limit=100
 * with pagination (next_page.uri), 429-aware backoff, and 5xx retry.
 *
 * THREAT-MODEL compliance:
 *   - §3.6 invariant 11: PAT is never logged or included in error
 *     messages. All error paths run through scrubPat() from
 *     @opencoo/shared/scrub.
 *   - §2 invariant 9: no env var for the PAT — resolved via
 *     credentialStore.read(credentialId) (CredentialStore pattern).
 *   - PAT is cached in-process after the first read to avoid
 *     repeated decrypt operations during pagination.
 */

import { scrubPat } from "@opencoo/shared/scrub";
import type { CredentialStore } from "@opencoo/shared/credential-store";
import type { CredentialId } from "@opencoo/shared/db";

/** Six fields from the PoC reference (TZLsyt2i4OkqwhqQ). */
export const DEFAULT_OPT_FIELDS = [
  "name",
  "assignee.name",
  "completed",
  "due_on",
  "modified_at",
  "memberships.section.name",
] as const satisfies readonly string[];

export interface AsanaTaskRow {
  readonly gid: string;
  readonly name: string;
  readonly assignee?: { readonly name: string } | null;
  readonly completed: boolean;
  readonly due_on: string | null;
  readonly modified_at: string;
  readonly memberships?: ReadonlyArray<{
    readonly section?: { readonly name: string };
  }>;
}

export interface ProjectSnapshot {
  readonly project_gid: string;
  readonly snapshot: ReadonlyArray<AsanaTaskRow>;
  readonly incomplete_count: number;
  readonly overdue_count: number;
  readonly fetched_at: string; // ISO
}

export interface AsanaClient {
  fetchProjectSnapshot(projectGid: string): Promise<ProjectSnapshot>;
}

export interface AsanaClientArgs {
  readonly credentialStore: CredentialStore;
  readonly credentialId: CredentialId;
  /** Defaults to 'https://app.asana.com/api/1.0'. */
  readonly baseUrl?: string;
  /** Defaults to DEFAULT_OPT_FIELDS. */
  readonly optFields?: readonly string[];
  /** Test seam for injecting a custom fetch implementation. */
  readonly fetchImpl?: typeof fetch;
  /** Base delay for retries in ms. Defaults to 500ms. Useful for tests. */
  readonly retryDelayMs?: number;
  /** Clock injection for deterministic tests (computes "today" for overdue). */
  readonly now?: () => Date;
  /**
   * PR-Q8 — extract the PAT from the credential record's plaintext.
   *
   * Default behaviour: treat the entire plaintext bytes as the PAT
   * (matches the test path where `seedCredential` writes a bare PAT).
   *
   * Production composition stores the asana credential as a JSON
   * blob `{"personal_access_token":"…","workspace_gid":"…"}` (the
   * `auth` half of the binding's `credentialSchema`); the
   * composition factory passes a callback that JSON.parses the
   * plaintext and returns `parsed.personal_access_token`.
   *
   * The callback runs once on the first fetchProjectSnapshot call
   * (the result is then cached in-process for the client's
   * lifetime, alongside the existing PAT cache).
   */
  readonly patFromRecord?: (plaintext: Buffer) => string;
}

const DEFAULT_BASE_URL = "https://app.asana.com/api/1.0";
const MAX_429_ATTEMPTS = 5;
const MAX_5XX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 30_000;

/**
 * Compute jittered exponential delay.
 * delay = min(baseMs * 2^attempt, maxMs) * jitter(0.75..1.25)
 */
function computeBackoffMs(baseMs: number, attempt: number): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), MAX_BACKOFF_MS);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exponential * jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap an error message through scrubPat to remove any embedded
 * credential bytes. THREAT-MODEL §3.6 invariant 11.
 */
function scrubError(err: unknown): Error {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const scrubbed = scrubPat(rawMessage);
  const out = new Error(scrubbed);
  // Preserve a sanitised stack trace if available
  if (err instanceof Error && err.stack !== undefined) {
    out.stack = scrubPat(err.stack);
  }
  return out;
}

interface AsanaPageResponse {
  readonly data: ReadonlyArray<AsanaTaskRow>;
  // M11: `offset` is declared in the Asana response but never read — pagination
  // follows `uri` directly. Keeping it in the type would be dead weight.
  readonly next_page: { readonly uri: string } | null;
}

/** Parse and validate the Asana tasks-list response. */
function parseAsanaTasksResponse(raw: unknown): AsanaPageResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("asana-client: response body is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj["data"])) {
    throw new Error("asana-client: response body missing 'data' array");
  }
  const nextPage =
    obj["next_page"] !== null &&
    typeof obj["next_page"] === "object" &&
    typeof (obj["next_page"] as Record<string, unknown>)["uri"] === "string"
      ? (obj["next_page"] as { uri: string })
      : null;
  return { data: obj["data"] as AsanaTaskRow[], next_page: nextPage };
}

/** Compute ISO UTC date string "YYYY-MM-DD" from a Date. */
function toUtcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Create an AsanaClient instance.
 *
 * The PAT is resolved from the CredentialStore on first fetch and
 * cached in-process for the client lifetime (one cache per instance).
 */
export function createAsanaClient(args: AsanaClientArgs): AsanaClient {
  const {
    credentialStore,
    credentialId,
    baseUrl = DEFAULT_BASE_URL,
    optFields = DEFAULT_OPT_FIELDS,
    fetchImpl = fetch,
    retryDelayMs = 500,
    now = () => new Date(),
    patFromRecord = (plaintext: Buffer): string => plaintext.toString("utf8"),
  } = args;

  // In-process PAT cache — resolved once, reused for all pages.
  let cachedPat: string | undefined;

  async function resolvePat(): Promise<string> {
    if (cachedPat !== undefined) return cachedPat;
    const record = await credentialStore.read(credentialId);
    cachedPat = patFromRecord(record.plaintext);
    return cachedPat;
  }

  /**
   * Fetch one URL (a page of tasks). Handles 429 and 5xx retries.
   * All error messages are scrubbed before re-throwing.
   *
   * Retry policy:
   *   - 429: up to MAX_429_ATTEMPTS, honouring Retry-After header.
   *   - 5xx + network error: up to MAX_5XX_ATTEMPTS, exponential backoff.
   *   - 4xx (non-429): fail immediately, no retry.
   */
  async function fetchPage(url: string, pat: string): Promise<AsanaPageResponse> {
    let rateAttempt = 0;
    let serverAttempt = 0;

    while (true) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${pat}`,
            "Accept": "application/json",
          },
        });
      } catch (err) {
        // Network error: count against the 5xx (server) budget.
        serverAttempt++;
        if (serverAttempt >= MAX_5XX_ATTEMPTS) throw scrubError(err);
        await sleep(computeBackoffMs(retryDelayMs, serverAttempt));
        continue;
      }

      if (response.status === 429) {
        rateAttempt++;
        if (rateAttempt >= MAX_429_ATTEMPTS) {
          throw scrubError(
            new Error(
              `asana-client: rate limited (429) after ${MAX_429_ATTEMPTS} attempts on ${scrubPat(url)}`,
            ),
          );
        }
        // Respect Retry-After if present; otherwise exponential + jitter.
        // I2: RFC 7231 §7.1.3 allows two forms:
        //   - Numeric seconds: "30"  → parse directly.
        //   - HTTP-date: "Wed, 21 Oct 2026 07:28:00 GMT" → Date.parse().
        // If neither parses validly, fall back to exponential backoff.
        const retryAfterHeader = response.headers.get("Retry-After");
        let delayMs: number;
        if (retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader)) {
          delayMs = parseInt(retryAfterHeader, 10) * 1000;
        } else if (retryAfterHeader !== null) {
          const parsed = Date.parse(retryAfterHeader);
          delayMs = Number.isNaN(parsed)
            ? computeBackoffMs(retryDelayMs, rateAttempt)
            : Math.max(0, parsed - Date.now());
        } else {
          delayMs = computeBackoffMs(retryDelayMs, rateAttempt);
        }
        await sleep(delayMs);
        continue;
      }

      if (response.status >= 500) {
        serverAttempt++;
        if (serverAttempt >= MAX_5XX_ATTEMPTS) {
          throw scrubError(
            new Error(
              `asana-client: server error (${response.status}) after ${MAX_5XX_ATTEMPTS} attempts`,
            ),
          );
        }
        await sleep(computeBackoffMs(retryDelayMs, serverAttempt));
        continue;
      }

      if (!response.ok) {
        // 4xx (other than 429): fail immediately, no retry.
        // THREAT-MODEL §3.6 invariant 11: no PAT in error message.
        throw scrubError(
          new Error(
            `asana-client: HTTP ${response.status} from Asana API (fail-fast on 4xx)`,
          ),
        );
      }

      // 2xx: parse JSON response.
      let json: unknown;
      try {
        json = await response.json();
      } catch (err) {
        throw scrubError(
          new Error(
            `asana-client: failed to parse JSON response: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
      return parseAsanaTasksResponse(json);
    }
  }

  return {
    async fetchProjectSnapshot(projectGid: string): Promise<ProjectSnapshot> {
      let pat: string;
      try {
        pat = await resolvePat();
      } catch (err) {
        throw scrubError(err);
      }

      const optFieldsParam = optFields.join(",");
      const firstUrl = `${baseUrl}/projects/${projectGid}/tasks?opt_fields=${encodeURIComponent(optFieldsParam)}&limit=100`;

      const allTasks: AsanaTaskRow[] = [];
      let nextUrl: string | null = firstUrl;

      while (nextUrl !== null) {
        let page: AsanaPageResponse;
        try {
          page = await fetchPage(nextUrl, pat);
        } catch (err) {
          throw scrubError(err);
        }
        allTasks.push(...page.data);
        nextUrl = page.next_page !== null ? page.next_page.uri : null;
      }

      // Compute metrics using ISO UTC date comparison.
      const todayStr = toUtcDateString(now());
      const incomplete_count = allTasks.filter((t) => !t.completed).length;
      const overdue_count = allTasks.filter(
        (t) =>
          !t.completed &&
          t.due_on !== null &&
          t.due_on < todayStr,
      ).length;

      return {
        project_gid: projectGid,
        snapshot: allTasks,
        incomplete_count,
        overdue_count,
        fetched_at: now().toISOString(),
      };
    },
  };
}
