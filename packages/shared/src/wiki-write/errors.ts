import { OpencooError, type OpencooErrorOptions } from "../errors.js";

// Adapter reported HEAD advanced between our read and our write.
// Classified `transient` so the retry loop inside `wikiWrite` sees it
// as "try again with a fresh parent SHA". External callers who reach
// the MAX_STALE_RETRIES ceiling get this error and should back off.
export class WikiWriteStaleError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "transient", options);
    this.name = "WikiWriteStaleError";
  }
}

// Per-domain daily delete budget exhausted. Routed `validation` so
// the caller DLQs the request — burning more budget on retries of
// a blocked request just delays the admin-review escalation.
export class WikiWriteCapExceededError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "WikiWriteCapExceededError";
  }
}

// Transport-level failure from the underlying adapter (Gitea 5xx,
// network timeout). Classified `transient` so upstream callers back
// off linearly; the adapter may surface a more specific error that
// the caller catches before reaching here.
export class WikiTransportError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "transient", options);
    this.name = "WikiTransportError";
  }
}

// Path-guard rejection (belt-and-suspenders check even if the caller
// pre-validates). Routed `validation` — a bad path is a caller bug,
// no retry will change the verdict.
export class WikiPathError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "WikiPathError";
  }
}

// Zod parse of the WikiWriteInput failed. Same fail-loud semantics
// as WikiPathError — caller must fix the shape before retry is
// meaningful.
export class WikiWriteInputError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "WikiWriteInputError";
  }
}
