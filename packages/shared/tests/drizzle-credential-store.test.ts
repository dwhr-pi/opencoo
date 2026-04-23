import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";

import * as schema from "../src/db/schema/index.js";
import { credentials } from "../src/db/schema/credentials.js";
import {
  IntegrityError,
  UnsupportedEncryptionVersionError,
} from "../src/credential-store/errors.js";
import { DrizzleCredentialStore } from "../src/credential-store/drizzle-store.js";
import type { CredentialId } from "../src/db/brands.js";
import { ConsoleLogger, type LoggerWriteStream } from "../src/logger.js";

type Db = PgliteDatabase<typeof schema>;

function nullLogger(): ConsoleLogger {
  const nullStream: LoggerWriteStream = {
    write(): boolean {
      return true;
    },
  };
  return new ConsoleLogger({ stream: nullStream });
}

// Initialise a fresh in-process Postgres (pglite WASM) per test — the
// instance is a real Postgres, so gen_random_uuid(), bytea round-trip,
// and FK semantics all behave correctly. pg-mem was considered and
// rejected: its bytea adapter re-encodes via UTF-8 text, breaking
// binary-fidelity round-trip.
async function freshStore(): Promise<{
  db: Db;
  store: DrizzleCredentialStore;
}> {
  const pg = new PGlite();
  await pg.query(`
    CREATE TABLE credentials (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      name text NOT NULL,
      schema_ref text NOT NULL,
      ciphertext bytea NOT NULL,
      iv bytea NOT NULL,
      aad bytea NOT NULL,
      encryption_version integer DEFAULT 1 NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      rotated_at timestamp with time zone
    );
  `);
  const db: Db = drizzle(pg, { schema });
  const store = new DrizzleCredentialStore({
    db,
    key: Buffer.alloc(32, 0x44),
    logger: nullLogger(),
  });
  return { db, store };
}

describe("DrizzleCredentialStore — round-trip via pglite", () => {
  let ctx: { db: Db; store: DrizzleCredentialStore };

  beforeEach(async () => {
    ctx = await freshStore();
  });

  it("write → read returns the original plaintext", async () => {
    const plain = Buffer.from("drive-oauth-refresh-token");
    const id = await ctx.store.write({
      name: "drive",
      schemaRef: "source-drive/v1",
      plaintext: plain,
    });
    const record = await ctx.store.read(id);
    expect(Buffer.compare(record.plaintext, plain)).toBe(0);
    expect(record.name).toBe("drive");
    expect(record.schemaRef).toBe("source-drive/v1");
  });

  it("round-trips binary plaintext with full byte fidelity", async () => {
    const plain = randomBytes(512);
    const id = await ctx.store.write({
      name: "cert",
      schemaRef: "x/v1",
      plaintext: plain,
    });
    const record = await ctx.store.read(id);
    expect(Buffer.compare(record.plaintext, plain)).toBe(0);
  });

  it("100 writes of identical plaintext produce 100 distinct IVs in the DB", async () => {
    const plain = Buffer.from("same");
    const ids: CredentialId[] = [];
    for (let i = 0; i < 100; i++) {
      const id = await ctx.store.write({
        name: "n",
        schemaRef: "s/v1",
        plaintext: plain,
      });
      ids.push(id);
    }
    const rows = await ctx.db.select().from(credentials);
    const ivs = new Set(rows.map((r) => Buffer.from(r.iv).toString("hex")));
    expect(ivs.size).toBe(100);
  });

  it("throws IntegrityError when ciphertext is tampered in the DB", async () => {
    const id = await ctx.store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("plain"),
    });
    // Zero out first byte of ciphertext.
    await ctx.db
      .update(credentials)
      .set({ ciphertext: Buffer.alloc(32, 0) })
      .where(eq(credentials.id, id));
    await expect(ctx.store.read(id)).rejects.toThrow(IntegrityError);
  });

  it("throws IntegrityError when iv is tampered in the DB", async () => {
    const id = await ctx.store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("plain"),
    });
    await ctx.db
      .update(credentials)
      .set({ iv: Buffer.alloc(12, 0xff) })
      .where(eq(credentials.id, id));
    await expect(ctx.store.read(id)).rejects.toThrow(IntegrityError);
  });

  it("throws IntegrityError when schema_ref is tampered in the DB (AAD re-derivation mismatch)", async () => {
    const id = await ctx.store.write({
      name: "n",
      schemaRef: "source-drive/v1",
      plaintext: Buffer.from("plain"),
    });
    await ctx.db
      .update(credentials)
      .set({ schemaRef: "source-asana/v1" })
      .where(eq(credentials.id, id));
    await expect(ctx.store.read(id)).rejects.toThrow(IntegrityError);
  });

  it("throws IntegrityError on AAD-swap attack (cross-row substitution)", async () => {
    const idA = await ctx.store.write({
      name: "a",
      schemaRef: "s/v1",
      plaintext: Buffer.from("secret-a"),
    });
    const idB = await ctx.store.write({
      name: "b",
      schemaRef: "s/v1",
      plaintext: Buffer.from("secret-b"),
    });
    const rowA = (
      await ctx.db.select().from(credentials).where(eq(credentials.id, idA))
    )[0];
    if (rowA === undefined) throw new Error("row A missing");
    // Move A's encrypted bytes into B's row.
    await ctx.db
      .update(credentials)
      .set({
        ciphertext: Buffer.from(rowA.ciphertext),
        iv: Buffer.from(rowA.iv),
        aad: Buffer.from(rowA.aad),
      })
      .where(eq(credentials.id, idB));
    await expect(ctx.store.read(idB)).rejects.toThrow(IntegrityError);
  });

  it("rotate replaces plaintext and sets rotated_at", async () => {
    const id = await ctx.store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("old"),
    });
    const before = (
      await ctx.db.select().from(credentials).where(eq(credentials.id, id))
    )[0];
    expect(before?.rotatedAt).toBeNull();
    await ctx.store.rotate(id, Buffer.from("new"));
    const after = (
      await ctx.db.select().from(credentials).where(eq(credentials.id, id))
    )[0];
    expect(after?.rotatedAt).not.toBeNull();
    const record = await ctx.store.read(id);
    expect(record.plaintext.toString("utf8")).toBe("new");
  });

  it("delete removes the row", async () => {
    const id = await ctx.store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("plain"),
    });
    await ctx.store.delete(id);
    await expect(ctx.store.read(id)).rejects.toThrow();
    const rows = await ctx.db
      .select()
      .from(credentials)
      .where(eq(credentials.id, id));
    expect(rows).toHaveLength(0);
  });

  it("delete of a missing id is idempotent", async () => {
    const fakeId = randomUUID() as CredentialId;
    await expect(ctx.store.delete(fakeId)).resolves.toBeUndefined();
  });

  it("read throws when the id is unknown", async () => {
    const fakeId = randomUUID() as CredentialId;
    await expect(ctx.store.read(fakeId)).rejects.toThrow();
  });

  it("throws UnsupportedEncryptionVersionError when the row carries an unknown version", async () => {
    const id = await ctx.store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("plain"),
    });
    await ctx.db.execute(
      sql`UPDATE credentials SET encryption_version = 99 WHERE id = ${id}`,
    );
    await expect(ctx.store.read(id)).rejects.toThrow(
      UnsupportedEncryptionVersionError,
    );
  });
});
