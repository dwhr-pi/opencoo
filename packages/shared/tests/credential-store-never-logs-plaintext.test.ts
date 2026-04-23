import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "../src/db/schema/index.js";
import { DrizzleCredentialStore } from "../src/credential-store/drizzle-store.js";
import { InMemoryCredentialStore } from "../src/credential-store/in-memory-store.js";
import type { CredentialStore } from "../src/credential-store/interface.js";
import { ConsoleLogger, type LoggerWriteStream } from "../src/logger.js";

// Sentinel plaintext the byte-scan looks for. Must NOT appear
// anywhere in the serialized log stream — not in a `msg`, not in a
// context value, not url-encoded, not base64. The test strings are
// chosen so accidental substring matches are extremely unlikely.
const SECRET_INITIAL = "SECRET-SENTINEL-b3c1a2-PLAINTEXT";
const SECRET_ROTATED = "ROTATED-SENTINEL-e7f091-PLAINTEXT";

interface StringStream extends LoggerWriteStream {
  readonly writes: string[];
}

function captureStream(): StringStream {
  const writes: string[] = [];
  return {
    writes,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
  };
}

function assertNoPlaintextLeak(writes: readonly string[]): void {
  for (const line of writes) {
    expect(line).not.toContain(SECRET_INITIAL);
    expect(line).not.toContain(SECRET_ROTATED);
    expect(line).not.toContain(Buffer.from(SECRET_INITIAL).toString("base64"));
    expect(line).not.toContain(Buffer.from(SECRET_ROTATED).toString("base64"));
    const parsed = JSON.parse(line) as unknown;
    const reserialised = JSON.stringify(parsed);
    expect(reserialised).not.toContain(SECRET_INITIAL);
    expect(reserialised).not.toContain(SECRET_ROTATED);
  }
}

async function runExerciseAndScan(
  store: CredentialStore,
  stream: StringStream,
): Promise<void> {
  const id = await store.write({
    name: "test",
    schemaRef: "source-x/v1",
    plaintext: Buffer.from(SECRET_INITIAL),
  });
  const record = await store.read(id);
  expect(record.plaintext.toString("utf8")).toBe(SECRET_INITIAL);
  await store.rotate(id, Buffer.from(SECRET_ROTATED));
  const after = await store.read(id);
  expect(after.plaintext.toString("utf8")).toBe(SECRET_ROTATED);
  await store.delete(id);

  const forbiddenKeys = ["plaintext", "secret", "password", "value"];
  for (const line of stream.writes) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const key of forbiddenKeys) {
      expect(Object.prototype.hasOwnProperty.call(parsed, key)).toBe(false);
    }
  }

  assertNoPlaintextLeak(stream.writes);

  expect(stream.writes.length).toBeGreaterThan(0);
}

describe("credential-store never logs plaintext — InMemoryCredentialStore", () => {
  it("write/read/rotate/read/delete emits no plaintext bytes", async () => {
    const stream = captureStream();
    const logger = new ConsoleLogger({ level: "debug", stream });
    const store = new InMemoryCredentialStore({
      key: Buffer.alloc(32, 0x55),
      logger,
    });
    await runExerciseAndScan(store, stream);
  });
});

describe("credential-store never logs plaintext — DrizzleCredentialStore", () => {
  it("write/read/rotate/read/delete emits no plaintext bytes", async () => {
    const stream = captureStream();
    const logger = new ConsoleLogger({ level: "debug", stream });
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
    const db = drizzle(pg, { schema });
    const store = new DrizzleCredentialStore({
      db,
      key: Buffer.alloc(32, 0x66),
      logger,
    });
    await runExerciseAndScan(store, stream);
  });
});
