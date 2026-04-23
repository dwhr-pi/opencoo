import { OpencooError, type OpencooErrorOptions } from "../errors.js";

// Decryption failed because AES-GCM's authentication tag mismatched,
// OR the application-level AAD check (id|schemaRef) did not match the
// persisted `aad` column. Both failure modes map to the same error —
// from the caller's perspective the stored row is not trustworthy.
// Routed as `validation` so retry logic treats it as a DLQ candidate,
// not a transient retry.
export class IntegrityError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "IntegrityError";
  }
}

// Encountered an `encryption_version` the current build does not know
// how to decrypt. Admin response: roll the engine back, or run a
// migration batch that re-encrypts under the current version.
export class UnsupportedEncryptionVersionError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "UnsupportedEncryptionVersionError";
  }
}

// Boot-time configuration error — `ENCRYPTION_KEY`/`_FILE` missing,
// malformed, or the decoded bytes aren't 32 bytes long. Distinct from
// a runtime crypto failure so the engine bootstrap can exit with a
// clear "fix your env" signal.
export class ConfigError extends OpencooError {
  constructor(message: string, options?: OpencooErrorOptions) {
    super(message, "validation", options);
    this.name = "ConfigError";
  }
}
