/**
 * Admin-API fetch wrapper (PR 29 / plan #131).
 *
 * Every request:
 *   - sends `Authorization: Bearer <PAT>` from sessionStorage,
 *   - sends `X-CSRF-Token` from the `opencoo_csrf` cookie on
 *     mutating requests (POST/PUT/PATCH/DELETE),
 *   - includes credentials so the cookie round-trips.
 *
 * Error shape:
 *   - 401 / 403 surface as `ApiAuthError` so the App can
 *     prompt the user to re-paste a PAT or escalate to an
 *     admin.
 *   - 4xx (other) surface as `ApiValidationError` carrying
 *     the parsed body.
 *   - 5xx / network surface as `ApiTransientError`.
 *
 * Auto-retry: a 403 with `{error:'csrf_invalid'}` triggers a
 * silent re-fetch of `/api/admin/_csrf`, then retries the
 * original request once. Documented behavior — operators
 * shouldn't see the CSRF refresh.
 */
import { getCsrfTokenFromCookie } from "./csrf.js";
import { getPat } from "./pat-store.js";

export class ApiAuthError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(status: number, reason?: string) {
    super(`Admin API auth failed (HTTP ${status}${reason ? `: ${reason}` : ""})`);
    this.name = "ApiAuthError";
    this.status = status;
    this.reason = reason;
  }
}

export class ApiValidationError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`Admin API validation error (HTTP ${status})`);
    this.name = "ApiValidationError";
    this.status = status;
    this.body = body;
  }
}

export class ApiTransientError extends Error {
  readonly status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.name = "ApiTransientError";
    this.status = status;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface FetchOpts {
  readonly method?: string;
  readonly body?: unknown;
  /** @internal Test seam — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
}

async function fetchAdminInternal(
  path: string,
  opts: FetchOpts,
  isRetry: boolean,
): Promise<Response> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  // Normalise method casing — `MUTATING.has` is case-sensitive and
  // a caller passing `"post"` would otherwise bypass CSRF header
  // injection AND the auto-retry path. Cheap defensive check.
  const method = (opts.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const pat = getPat();
  if (pat !== null) {
    headers["authorization"] = `Bearer ${pat}`;
  }
  if (MUTATING.has(method)) {
    const csrf = getCsrfTokenFromCookie();
    if (csrf !== null) {
      headers["x-csrf-token"] = csrf;
    }
  }
  const init: RequestInit = {
    method,
    headers,
    credentials: "include",
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetchFn(path, init);

  if (res.status === 403 && MUTATING.has(method) && !isRetry) {
    // Read the body to confirm csrf_invalid; consume it so the
    // outer call can't try to read a drained stream.
    let body: { error?: string } = {};
    try {
      body = (await res.clone().json()) as { error?: string };
    } catch {
      // ignore
    }
    if (body.error === "csrf_invalid") {
      // Refetch the CSRF cookie + retry once.
      await fetchFn("/api/admin/_csrf", {
        method: "GET",
        headers: pat ? { authorization: `Bearer ${pat}` } : {},
        credentials: "include",
      });
      return fetchAdminInternal(path, opts, true);
    }
  }

  return res;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function fetchAdmin<T = unknown>(
  path: string,
  opts: FetchOpts = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetchAdminInternal(path, opts, false);
  } catch (err) {
    throw new ApiTransientError(
      null,
      err instanceof Error ? err.message : String(err),
    );
  }
  if (res.ok) {
    return (await readBody(res)) as T;
  }
  const body = await readBody(res);
  if (res.status === 401) {
    const reason = (body as { reason?: string } | undefined)?.reason;
    throw new ApiAuthError(401, reason);
  }
  if (res.status === 403) {
    const reason = (body as { reason?: string } | undefined)?.reason;
    throw new ApiAuthError(403, reason);
  }
  if (res.status >= 400 && res.status < 500) {
    throw new ApiValidationError(res.status, body);
  }
  throw new ApiTransientError(res.status, `HTTP ${res.status}`);
}

/**
 * Build `fetchAdmin`'s options object only when an override is provided.
 *
 * `exactOptionalPropertyTypes` is on, so passing `{ fetchImpl: undefined }`
 * is *not* the same as omitting the field — the literal `undefined` would
 * shadow the prop's optional default. Routes that thread `fetchImpl` from
 * a test seam should funnel it through this helper to stay safe.
 */
export function fetchOptsFor(
  fetchImpl: typeof fetch | undefined,
): { fetchImpl?: typeof fetch } {
  return fetchImpl !== undefined ? { fetchImpl } : {};
}
