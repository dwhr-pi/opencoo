/**
 * WebhookVerifier port — verify an inbound webhook's signature
 * against a secret + raw body. Engine-ingestion's webhook receiver
 * (PR 14) consumes this via DI; future SourceAdapter (PR 23+) will
 * absorb the surface as `adapter.verifyWebhook(...)`.
 *
 * The port is deliberately stateless: each `verify()` call carries
 * everything it needs (body bytes, secret bytes, signature header
 * value). Adapters that need to fetch a different secret per
 * binding handle that lookup OUTSIDE the verifier.
 */
import { OpencooError, type OpencooErrorOptions } from "../errors.js";

/**
 * What a verifier is asked. `signature` is OPTIONAL — receivers
 * commonly call `verify` even when the request had no signature
 * header at all, and the verifier surfaces that as a structured
 * `{ok:false, reason:'missing'}` rather than forcing the caller
 * to special-case it.
 */
export interface WebhookVerifyArgs {
  readonly body: Buffer;
  readonly secret: Buffer;
  readonly signature: string | undefined;
}

/** Discriminated result. `ok:true` is the only success case. */
export type WebhookVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface WebhookVerifier {
  verify(args: WebhookVerifyArgs): WebhookVerifyResult;
}

/**
 * Typed error for callers that prefer throwing over checking
 * `.ok`. Pinned to `errorClass:'validation'` so retry policy treats
 * it as a bad-input DLQ case — replaying the same body+secret won't
 * make the signature match.
 */
export class WebhookSignatureError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "WebhookSignatureError";
  }
}
