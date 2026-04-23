import type { CredentialId } from "../db/brands.js";

// Input shape for credential creation. Plaintext is Buffer so tokens,
// binary certs, and arbitrary byte blobs all work.
export interface CredentialInput {
  readonly name: string;
  readonly schemaRef: string;
  readonly plaintext: Buffer;
}

// Decrypted view returned by `read`. Callers that need to tie the
// plaintext to its id should pass the id through alongside.
export interface CredentialRecord {
  readonly name: string;
  readonly schemaRef: string;
  readonly plaintext: Buffer;
}

// The store interface — every concrete implementation (in-memory,
// Drizzle-backed Postgres, future KMS-backed) must satisfy this
// shape. Keeping the surface minimal means a KMS swap is a
// constructor substitution, not an API rewrite.
//
// Contract:
// - `write` generates the id server-side and returns it. Callers must
//   NOT supply an id.
// - `read` returns the decrypted record or throws (not-found or
//   IntegrityError). It never returns a null/undefined plaintext.
// - `rotate` replaces the plaintext, stamps `rotated_at`, emits a
//   fresh IV, and preserves name/schemaRef.
// - `delete` is idempotent — a second call for the same id does not
//   throw.
export interface CredentialStore {
  write(input: CredentialInput): Promise<CredentialId>;
  read(id: CredentialId): Promise<CredentialRecord>;
  rotate(id: CredentialId, plaintext: Buffer): Promise<void>;
  delete(id: CredentialId): Promise<void>;
}

// Derive the AAD bytes `aad` column stores and `decryptV1` re-checks.
// Binding `(id, schemaRef)` means substituting a valid row from a
// different credential cannot pass integrity — the stored aad won't
// equal the re-derivation even if the attacker also moves aad over.
export function deriveAad(id: CredentialId, schemaRef: string): Buffer {
  return Buffer.from(`${id}|${schemaRef}`, "utf8");
}
