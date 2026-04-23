/**
 * Gitea OAuth token validation — used by the hybrid bearer middleware when a
 * request presents a token that is NOT the static `MCP_BEARER_TOKEN`.
 *
 * Strategy: call Gitea's own userinfo endpoint with the token. Gitea returns
 * 200 + user JSON iff the token is a valid, non-expired access token issued
 * by its OAuth2 provider. Anything else → reject.
 *
 * Wrapped in an LRU cache (5-min TTL, 200 entries) so we don't hammer Gitea
 * on every tool call. Tokens live ~1h; a 5-min cache is a reasonable bound
 * between "fresh revocation" and "don't DDoS Gitea".
 */
import { LRUCache } from "lru-cache";

export interface GiteaUser {
  login: string;
  email?: string;
  name?: string;
}

export interface ValidationResult {
  valid: boolean;
  user?: GiteaUser;
}

export interface GiteaOAuthValidator {
  validate(token: string): Promise<ValidationResult>;
  invalidate(token: string): void;
  size(): number;
}

interface ValidatorOptions {
  /** Base URL of the Gitea instance, e.g. "https://gitea.example.com". */
  giteaBaseUrl: string;
  /** TTL in ms. Defaults to 5 minutes. */
  ttlMs?: number;
  /** Max cached tokens. Defaults to 200. */
  maxEntries?: number;
  /** Override fetch — test seam. */
  fetchImpl?: typeof fetch;
}

/**
 * Construct a validator. All state lives on the returned object; safe to call
 * once at boot and reuse. A separate `createGiteaOAuthValidator` call produces
 * an isolated cache — useful in tests.
 */
export function createGiteaOAuthValidator(opts: ValidatorOptions): GiteaOAuthValidator {
  const base = opts.giteaBaseUrl.replace(/\/+$/, "");
  const userinfoUrl = `${base}/login/oauth/userinfo`;
  const ttl = opts.ttlMs ?? 5 * 60 * 1000;
  const max = opts.maxEntries ?? 200;
  const fetcher = opts.fetchImpl ?? fetch;

  const cache = new LRUCache<string, ValidationResult>({
    max,
    ttl,
    // Don't extend TTL on read — a revoked token should fall out after ≤ ttl.
    updateAgeOnGet: false,
  });

  async function validate(token: string): Promise<ValidationResult> {
    if (!token) return { valid: false };
    const cached = cache.get(token);
    if (cached) return cached;

    let res: Response;
    try {
      res = await fetcher(userinfoUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (err) {
      // Network error: don't cache — next call may succeed.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gitea-oauth] userinfo error: ${msg}`);
      return { valid: false };
    }

    // Only cache successful validations — otherwise a brief Gitea outage
    // would lock users out for the full TTL. Negative results are re-checked
    // on the next call.
    const result = res.status === 200 ? await parseUserinfo(res) : { valid: false };
    if (result.valid) cache.set(token, result);
    return result;
  }

  function invalidate(token: string): void {
    cache.delete(token);
  }

  function size(): number {
    return cache.size;
  }

  return { validate, invalidate, size };
}

async function parseUserinfo(res: Response): Promise<ValidationResult> {
  const body = (await res.json()) as Record<string, unknown>;
  // Gitea OIDC userinfo uses 'preferred_username'; fall back to 'login' for
  // hypothetical non-OIDC responses.
  const login =
    typeof body.preferred_username === "string" ? body.preferred_username
    : typeof body.login === "string" ? body.login
    : null;
  if (!login) return { valid: false };
  const user: GiteaUser = { login };
  if (typeof body.email === "string") user.email = body.email;
  if (typeof body.name === "string") user.name = body.name;
  return { valid: true, user };
}
