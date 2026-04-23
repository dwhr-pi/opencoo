import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  IntegrityError,
  UnsupportedEncryptionVersionError,
} from "../src/credential-store/errors.js";
import { InMemoryCredentialStore } from "../src/credential-store/in-memory-store.js";
import { ConsoleLogger, type LoggerWriteStream } from "../src/logger.js";

function nullLogger(): ConsoleLogger {
  const nullStream: LoggerWriteStream = {
    write(): boolean {
      return true;
    },
  };
  return new ConsoleLogger({ stream: nullStream });
}

function newStore(): InMemoryCredentialStore {
  return new InMemoryCredentialStore({
    key: Buffer.alloc(32, 0x33),
    logger: nullLogger(),
  });
}

describe("InMemoryCredentialStore — round-trip", () => {
  it("write → read returns the original plaintext", async () => {
    const store = newStore();
    const plain = Buffer.from("secret-token-abc");
    const id = await store.write({
      name: "drive",
      schemaRef: "source-drive/v1",
      plaintext: plain,
    });
    const record = await store.read(id);
    expect(Buffer.compare(record.plaintext, plain)).toBe(0);
    expect(record.name).toBe("drive");
    expect(record.schemaRef).toBe("source-drive/v1");
  });

  it("returns a branded CredentialId", async () => {
    const store = newStore();
    const id = await store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("x"),
    });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("supports binary plaintext (non-UTF8)", async () => {
    const store = newStore();
    const plain = randomBytes(256);
    const id = await store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: plain,
    });
    const record = await store.read(id);
    expect(Buffer.compare(record.plaintext, plain)).toBe(0);
  });
});

describe("InMemoryCredentialStore — IV uniqueness", () => {
  it("100 writes of identical plaintext produce 100 distinct IVs", async () => {
    const store = newStore();
    const plain = Buffer.from("same-every-time");
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = await store.write({
        name: "n",
        schemaRef: "s/v1",
        plaintext: plain,
      });
      ids.push(id);
    }
    const ivs = new Set(ids.map((id) => store.rawIvFor(id).toString("hex")));
    expect(ivs.size).toBe(100);
  });
});

describe("InMemoryCredentialStore — integrity failures", () => {
  it("throws IntegrityError when ciphertext is tampered", async () => {
    const store = newStore();
    const id = await store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("plain"),
    });
    const row = store.rawRowFor(id);
    row.ciphertext[0] = (row.ciphertext[0] ?? 0) ^ 0x01;
    await expect(store.read(id)).rejects.toThrow(IntegrityError);
  });

  it("throws IntegrityError when IV is tampered", async () => {
    const store = newStore();
    const id = await store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("plain"),
    });
    const row = store.rawRowFor(id);
    row.iv[0] = (row.iv[0] ?? 0) ^ 0x01;
    await expect(store.read(id)).rejects.toThrow(IntegrityError);
  });

  it("throws IntegrityError when a different row's bytes are substituted (AAD-swap attack)", async () => {
    const store = newStore();
    const idA = await store.write({
      name: "a",
      schemaRef: "s/v1",
      plaintext: Buffer.from("secret-a"),
    });
    const idB = await store.write({
      name: "b",
      schemaRef: "s/v1",
      plaintext: Buffer.from("secret-b"),
    });
    const rowA = store.rawRowFor(idA);
    const rowB = store.rawRowFor(idB);
    rowB.ciphertext = rowA.ciphertext;
    rowB.iv = rowA.iv;
    rowB.aad = rowA.aad;
    await expect(store.read(idB)).rejects.toThrow(IntegrityError);
  });

  it("throws IntegrityError when schemaRef is tampered (AAD re-derivation fails)", async () => {
    const store = newStore();
    const id = await store.write({
      name: "n",
      schemaRef: "source-drive/v1",
      plaintext: Buffer.from("plain"),
    });
    const row = store.rawRowFor(id);
    row.schemaRef = "source-asana/v1";
    await expect(store.read(id)).rejects.toThrow(IntegrityError);
  });
});

describe("InMemoryCredentialStore — rotate", () => {
  it("replaces the plaintext and updates rotated_at", async () => {
    const store = newStore();
    const id = await store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("old"),
    });
    const beforeRotate = store.rawRowFor(id).rotatedAt;
    expect(beforeRotate).toBeNull();
    await store.rotate(id, Buffer.from("new"));
    const record = await store.read(id);
    expect(record.plaintext.toString("utf8")).toBe("new");
    const afterRotate = store.rawRowFor(id).rotatedAt;
    expect(afterRotate).not.toBeNull();
    expect(afterRotate instanceof Date).toBe(true);
  });

  it("generates a fresh IV on rotate", async () => {
    const store = newStore();
    const id = await store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("old"),
    });
    const ivBefore = store.rawRowFor(id).iv.toString("hex");
    await store.rotate(id, Buffer.from("new"));
    const ivAfter = store.rawRowFor(id).iv.toString("hex");
    expect(ivAfter).not.toBe(ivBefore);
  });
});

describe("InMemoryCredentialStore — delete", () => {
  it("delete then read throws", async () => {
    const store = newStore();
    const id = await store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("plain"),
    });
    await store.delete(id);
    await expect(store.read(id)).rejects.toThrow();
  });

  it("delete is idempotent", async () => {
    const store = newStore();
    const id = await store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("plain"),
    });
    await store.delete(id);
    await expect(store.delete(id)).resolves.toBeUndefined();
  });
});

describe("InMemoryCredentialStore — version dispatch", () => {
  it("throws UnsupportedEncryptionVersionError when the row was stamped with an unknown version", async () => {
    const store = newStore();
    const id = await store.write({
      name: "n",
      schemaRef: "s/v1",
      plaintext: Buffer.from("plain"),
    });
    const row = store.rawRowFor(id);
    row.encryptionVersion = 99;
    await expect(store.read(id)).rejects.toThrow(
      UnsupportedEncryptionVersionError,
    );
  });
});
