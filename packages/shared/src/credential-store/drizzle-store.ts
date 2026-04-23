import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { CredentialId } from "../db/brands.js";
import { credentials } from "../db/schema/credentials.js";
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

// Type-parameterised on `PgDatabase` so any drizzle-orm postgres
// backend satisfies the dependency (node-postgres for prod, pglite
// for in-process tests, etc). The store never introspects the
// driver-specific surface — only calls `select().from`, `insert`,
// `update().set`, `delete`.
export type CredentialStoreDb = PgDatabase<
  PgQueryResultHKT,
  Record<string, unknown>
>;

export interface DrizzleCredentialStoreOptions {
  readonly db: CredentialStoreDb;
  readonly key: Buffer;
  readonly logger: Logger;
}

export class DrizzleCredentialStore implements CredentialStore {
  private readonly db: CredentialStoreDb;
  private readonly key: Buffer;
  private readonly logger: Logger;

  constructor(options: DrizzleCredentialStoreOptions) {
    this.db = options.db;
    this.key = options.key;
    this.logger = options.logger;
  }

  async write(input: CredentialInput): Promise<CredentialId> {
    const id = randomUUID() as CredentialId;
    const aad = deriveAad(id, input.schemaRef);
    const { iv, ciphertext } = encryptV1(this.key, aad, input.plaintext);
    await this.db.insert(credentials).values({
      id,
      name: input.name,
      schemaRef: input.schemaRef,
      ciphertext,
      iv,
      aad,
      encryptionVersion: CURRENT_VERSION,
    });
    this.logger.info("credential.write", {
      credential_id: id,
      schema_ref: input.schemaRef,
    });
    return id;
  }

  async read(id: CredentialId): Promise<CredentialRecord> {
    const rows = await this.db
      .select()
      .from(credentials)
      .where(eq(credentials.id, id));
    const row = rows[0];
    if (row === undefined) {
      this.logger.info("credential.read_failed", {
        credential_id: id,
        reason: "not_found",
      });
      throw new IntegrityError(`credential ${id} not found`);
    }

    const derivedAad = deriveAad(id, row.schemaRef);
    const persistedAad = Buffer.from(row.aad);
    if (!derivedAad.equals(persistedAad)) {
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
      Buffer.from(row.iv),
      Buffer.from(row.ciphertext),
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
    const rows = await this.db
      .select({ schemaRef: credentials.schemaRef })
      .from(credentials)
      .where(eq(credentials.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new IntegrityError(`credential ${id} not found`);
    }
    const aad = deriveAad(id, row.schemaRef);
    const { iv, ciphertext } = encryptV1(this.key, aad, plaintext);
    await this.db
      .update(credentials)
      .set({
        iv,
        ciphertext,
        aad,
        encryptionVersion: CURRENT_VERSION,
        rotatedAt: new Date(),
      })
      .where(eq(credentials.id, id));
    this.logger.info("credential.rotate", {
      credential_id: id,
      schema_ref: row.schemaRef,
    });
  }

  async delete(id: CredentialId): Promise<void> {
    await this.db.delete(credentials).where(eq(credentials.id, id));
    this.logger.info("credential.delete", { credential_id: id });
  }
}
