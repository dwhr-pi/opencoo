import { randomBytes, randomUUID } from "node:crypto";

import type { CredentialId } from "../db/brands.js";
import type { Logger } from "../logger.js";
import {
  CURRENT_VERSION,
  decryptVersion,
  encryptV1,
} from "./aes-gcm.js";
import { IntegrityError } from "./errors.js";
import {
  deriveAad,
  type CredentialInput,
  type CredentialRecord,
  type CredentialStore,
} from "./interface.js";

// Internal row shape — mirrors the `credentials` Drizzle table so the
// test harness can tamper with individual columns the same way a
// DrizzleCredentialStore consumer would see them.
interface StoredRow {
  name: string;
  schemaRef: string;
  ciphertext: Buffer;
  iv: Buffer;
  aad: Buffer;
  encryptionVersion: number;
  createdAt: Date;
  rotatedAt: Date | null;
}

export interface InMemoryCredentialStoreOptions {
  readonly key?: Buffer;
  readonly logger: Logger;
}

// In-memory CredentialStore fixture. Mirrors the encrypt-on-write /
// decrypt-on-read shape of the Drizzle-backed impl byte-for-byte, so
// use-case tests that operate on the `CredentialStore` interface
// behave identically regardless of which implementation is wired in.
//
// Exposes `rawRowFor(id)` and `rawIvFor(id)` as TEST-ONLY helpers —
// they leak the internal row for targeted tampering. Production code
// MUST NOT use them; they're the only way to test the AAD-swap
// attack path without spinning up a real DB.
export class InMemoryCredentialStore implements CredentialStore {
  private readonly key: Buffer;
  private readonly logger: Logger;
  private readonly rows = new Map<CredentialId, StoredRow>();

  constructor(options: InMemoryCredentialStoreOptions) {
    this.key = options.key ?? randomBytes(32);
    this.logger = options.logger;
  }

  async write(input: CredentialInput): Promise<CredentialId> {
    const id = randomUUID() as CredentialId;
    const aad = deriveAad(id, input.schemaRef);
    const { iv, ciphertext } = encryptV1(this.key, aad, input.plaintext);
    this.rows.set(id, {
      name: input.name,
      schemaRef: input.schemaRef,
      ciphertext,
      iv,
      aad,
      encryptionVersion: CURRENT_VERSION,
      createdAt: new Date(),
      rotatedAt: null,
    });
    this.logger.info("credential.write", {
      credential_id: id,
      schema_ref: input.schemaRef,
    });
    return id;
  }

  async read(id: CredentialId): Promise<CredentialRecord> {
    const row = this.rows.get(id);
    if (row === undefined) {
      this.logger.info("credential.read_failed", {
        credential_id: id,
        reason: "not_found",
      });
      throw new IntegrityError(`credential ${id} not found`);
    }
    const derivedAad = deriveAad(id, row.schemaRef);
    if (!derivedAad.equals(row.aad)) {
      this.logger.info("credential.read_failed", {
        credential_id: id,
        reason: "aad_mismatch",
      });
      throw new IntegrityError(`credential ${id} aad mismatch`);
    }
    const plaintext = decryptVersion(
      row.encryptionVersion,
      this.key,
      derivedAad,
      row.iv,
      row.ciphertext,
    );
    this.logger.info("credential.read", {
      credential_id: id,
      schema_ref: row.schemaRef,
    });
    return {
      name: row.name,
      schemaRef: row.schemaRef,
      plaintext,
    };
  }

  async rotate(id: CredentialId, plaintext: Buffer): Promise<void> {
    const row = this.rows.get(id);
    if (row === undefined) {
      throw new IntegrityError(`credential ${id} not found`);
    }
    const aad = deriveAad(id, row.schemaRef);
    const { iv, ciphertext } = encryptV1(this.key, aad, plaintext);
    row.iv = iv;
    row.ciphertext = ciphertext;
    row.aad = aad;
    row.encryptionVersion = CURRENT_VERSION;
    row.rotatedAt = new Date();
    this.logger.info("credential.rotate", {
      credential_id: id,
      schema_ref: row.schemaRef,
    });
  }

  async delete(id: CredentialId): Promise<void> {
    const existed = this.rows.delete(id);
    if (existed) {
      this.logger.info("credential.delete", { credential_id: id });
    }
  }

  /** TEST ONLY — expose the internal row for tamper scenarios. */
  rawRowFor(id: CredentialId): StoredRow {
    const row = this.rows.get(id);
    if (row === undefined) {
      throw new Error(`test helper: id ${id} not in store`);
    }
    return row;
  }

  /** TEST ONLY — expose the IV for uniqueness assertions. */
  rawIvFor(id: CredentialId): Buffer {
    return this.rawRowFor(id).iv;
  }
}
