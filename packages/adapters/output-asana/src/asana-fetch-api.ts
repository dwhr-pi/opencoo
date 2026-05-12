/**
 * Production `AsanaLikeApi` implementation backed by `fetch`
 * (PR-Z4, phase-a appendix #12 G5).
 *
 * The package intentionally avoids importing the Asana node SDK
 * (PR 24 design note: "dependency-light"). v0.1 needs one
 * concrete `AsanaLikeApi` implementation for production wiring;
 * the simplest non-SDK path is the documented REST endpoint
 * `POST /api/1.0/tasks`.
 *
 * Error mapping (mirrors the adapter's `classifyHttpError`
 * shape):
 *   - 429 → `AsanaApiHttpError` with `retryAfterSeconds` parsed
 *     from the `Retry-After` header.
 *   - 4xx (other) → `AsanaApiHttpError` (no retryAfter).
 *   - 5xx → `AsanaApiHttpError` (the adapter classifier maps
 *     5xx to transient).
 *   - network failure → `AsanaApiTransientError`.
 *
 * THREAT-MODEL §3.6 invariant 11: the access token NEVER appears
 * in `Error.message`. The fetch wrapper builds the Authorization
 * header internally and throws with a generic "asana: <status>
 * <text>" shape — the response body's first 200 chars are
 * included but the request body / headers are NOT.
 */
import type {
  AsanaApiError,
  AsanaCreateTaskArgs,
  AsanaCreateTaskResult,
  AsanaLikeApi,
} from "./asana-api.js";

const DEFAULT_BASE_URL = "https://app.asana.com/api/1.0" as const;

export interface CreateAsanaFetchApiArgs {
  /** Optional override for the base URL. Defaults to
   *  `https://app.asana.com/api/1.0`. */
  readonly baseUrl?: string;
  /** Test seam for fetch injection. Defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Truncate a string to at most `max` UTF-8 bytes. Used to bound
 *  the Asana response body excerpt we include in error messages. */
function truncateBytes(input: string, max: number): string {
  if (Buffer.byteLength(input, "utf8") <= max) return input;
  let out = "";
  let used = 0;
  for (const ch of input) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (used + chBytes > max) break;
    out += ch;
    used += chBytes;
  }
  return out;
}

/** Parse the optional `Retry-After` header. Asana returns this as
 *  a number-of-seconds integer on 429 responses. Returns `undefined`
 *  when the header is absent or unparseable. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/** Construct a `fetch`-backed `AsanaLikeApi`. Production wiring
 *  uses this; tests inject `makeMockAsanaApi` from
 *  `./testing/mock-asana-tasks.ts` instead. */
export function createAsanaFetchApi(
  args: CreateAsanaFetchApiArgs = {},
): AsanaLikeApi {
  const baseUrl = args.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = args.fetchImpl ?? fetch;
  return {
    async createTask(
      callArgs: AsanaCreateTaskArgs,
    ): Promise<AsanaCreateTaskResult> {
      const url = `${baseUrl}/tasks?opt_fields=permalink_url`;
      // Asana's `POST /tasks` accepts a `data` envelope. The PAT
      // flows in via the Authorization header; we render it from
      // the Buffer once, locally, and never log it.
      const tokenStr = callArgs.accessToken.toString("utf8");
      // PR-W2 (phase-a appendix #13) — the adapter validates that
      // exactly ONE of `notes` / `htmlNotes` is set; we mirror that
      // discriminator here so the Asana REST payload carries either
      // `notes` or `html_notes` but never both (Asana 400s on both).
      const body: Record<string, unknown> = {
        data: {
          name: callArgs.title,
          ...(callArgs.notes !== undefined ? { notes: callArgs.notes } : {}),
          ...(callArgs.htmlNotes !== undefined
            ? { html_notes: callArgs.htmlNotes }
            : {}),
          projects: [callArgs.projectGid],
          ...(callArgs.dueOn !== undefined ? { due_on: callArgs.dueOn } : {}),
          ...(callArgs.assigneeGid !== undefined
            ? { assignee: callArgs.assigneeGid }
            : {}),
        },
      };
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${tokenStr}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        const transient: AsanaApiError = {
          kind: "transient",
          message: err instanceof Error ? err.message : String(err),
        };
        throw transient;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const httpError: AsanaApiError = {
          kind: "http",
          status: response.status,
          message: `asana: ${response.status} ${response.statusText}: ${truncateBytes(text, 200)}`,
          ...(response.status === 429
            ? (() => {
                const retryAfter = parseRetryAfter(
                  response.headers.get("retry-after"),
                );
                return retryAfter !== undefined
                  ? { retryAfterSeconds: retryAfter }
                  : {};
              })()
            : {}),
        };
        throw httpError;
      }
      const parsed = (await response.json().catch(() => null)) as
        | { data?: { gid?: string; permalink_url?: string } }
        | null;
      const gid = parsed?.data?.gid;
      if (typeof gid !== "string" || gid.length === 0) {
        const transient: AsanaApiError = {
          kind: "transient",
          message: "asana: response missing data.gid",
        };
        throw transient;
      }
      const permalinkUrl = parsed?.data?.permalink_url;
      return {
        gid,
        ...(typeof permalinkUrl === "string" && permalinkUrl.length > 0
          ? { permalinkUrl }
          : {}),
      };
    },
  };
}
