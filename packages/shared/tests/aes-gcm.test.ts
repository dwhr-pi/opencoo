import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CURRENT_VERSION,
  decryptV1,
  decryptVersion,
  encryptV1,
} from "../src/credential-store/aes-gcm.js";
import {
  IntegrityError,
  UnsupportedEncryptionVersionError,
} from "../src/credential-store/errors.js";

const KEY = Buffer.alloc(32, 0x11);
const AAD = Buffer.from("cred-id-123|source-drive/v1", "utf8");

describe("encryptV1 / decryptV1 round-trip", () => {
  it("CURRENT_VERSION is 1", () => {
    expect(CURRENT_VERSION).toBe(1);
  });

  it("round-trips a short plaintext", () => {
    const plain = Buffer.from("hello", "utf8");
    const { iv, ciphertext } = encryptV1(KEY, AAD, plain);
    const decrypted = decryptV1(KEY, AAD, iv, ciphertext);
    expect(Buffer.compare(decrypted, plain)).toBe(0);
  });

  it("round-trips arbitrary binary plaintext", () => {
    const plain = randomBytes(1024);
    const { iv, ciphertext } = encryptV1(KEY, AAD, plain);
    const decrypted = decryptV1(KEY, AAD, iv, ciphertext);
    expect(Buffer.compare(decrypted, plain)).toBe(0);
  });

  it("emits a 12-byte IV", () => {
    const plain = Buffer.from("abc");
    const { iv } = encryptV1(KEY, AAD, plain);
    expect(iv.length).toBe(12);
  });

  it("appends a 16-byte GCM auth tag to the ciphertext", () => {
    const plain = Buffer.from("abc");
    const { ciphertext } = encryptV1(KEY, AAD, plain);
    // AES-GCM is a stream cipher; ciphertext-body length equals plaintext length,
    // plus 16 bytes for the auth tag.
    expect(ciphertext.length).toBe(plain.length + 16);
  });
});

describe("encryptV1 — IV uniqueness (property test)", () => {
  it("produces 100 distinct IVs for 100 encrypts of identical plaintext", () => {
    const plain = Buffer.from("same-every-time", "utf8");
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { iv } = encryptV1(KEY, AAD, plain);
      seen.add(iv.toString("hex"));
    }
    expect(seen.size).toBe(100);
  });
});

describe("decryptV1 — integrity failures", () => {
  it("throws IntegrityError on flipped ciphertext byte", () => {
    const plain = Buffer.from("tampered?");
    const { iv, ciphertext } = encryptV1(KEY, AAD, plain);
    // Flip the first byte of the ciphertext body (not the tag).
    const tampered = Buffer.from(ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    expect(() => decryptV1(KEY, AAD, iv, tampered)).toThrow(IntegrityError);
  });

  it("throws IntegrityError on flipped IV byte", () => {
    const plain = Buffer.from("tampered?");
    const { iv, ciphertext } = encryptV1(KEY, AAD, plain);
    const tamperedIv = Buffer.from(iv);
    tamperedIv[0] = (tamperedIv[0] ?? 0) ^ 0x01;
    expect(() => decryptV1(KEY, AAD, tamperedIv, ciphertext)).toThrow(
      IntegrityError,
    );
  });

  it("throws IntegrityError on flipped auth tag byte", () => {
    const plain = Buffer.from("tampered?");
    const { iv, ciphertext } = encryptV1(KEY, AAD, plain);
    const tampered = Buffer.from(ciphertext);
    // Last byte is inside the 16-byte tag.
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0x01;
    expect(() => decryptV1(KEY, AAD, iv, tampered)).toThrow(IntegrityError);
  });

  it("throws IntegrityError when AAD doesn't match encryption AAD", () => {
    const plain = Buffer.from("bound to aad");
    const { iv, ciphertext } = encryptV1(KEY, AAD, plain);
    const wrongAad = Buffer.from("different-aad", "utf8");
    expect(() => decryptV1(KEY, wrongAad, iv, ciphertext)).toThrow(
      IntegrityError,
    );
  });

  it("throws IntegrityError when decrypted with a different key", () => {
    const plain = Buffer.from("bound to key");
    const { iv, ciphertext } = encryptV1(KEY, AAD, plain);
    const otherKey = Buffer.alloc(32, 0x22);
    expect(() => decryptV1(otherKey, AAD, iv, ciphertext)).toThrow(
      IntegrityError,
    );
  });
});

describe("decryptVersion dispatch", () => {
  it("routes version 1 to decryptV1", () => {
    const plain = Buffer.from("v1 payload");
    const { iv, ciphertext } = encryptV1(KEY, AAD, plain);
    const out = decryptVersion(1, KEY, AAD, iv, ciphertext);
    expect(Buffer.compare(out, plain)).toBe(0);
  });

  it("throws UnsupportedEncryptionVersionError for unknown versions", () => {
    const plain = Buffer.from("unknown");
    const { iv, ciphertext } = encryptV1(KEY, AAD, plain);
    expect(() => decryptVersion(99, KEY, AAD, iv, ciphertext)).toThrow(
      UnsupportedEncryptionVersionError,
    );
  });

  it("throws UnsupportedEncryptionVersionError for version 0", () => {
    expect(() =>
      decryptVersion(0, KEY, AAD, Buffer.alloc(12), Buffer.alloc(32)),
    ).toThrow(UnsupportedEncryptionVersionError);
  });
});
