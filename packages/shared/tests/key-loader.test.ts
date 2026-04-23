import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConfigError } from "../src/credential-store/errors.js";
import { loadEncryptionKey } from "../src/credential-store/key-loader.js";

// 32 bytes as a base64 string — the canonical shape the loader expects.
const BASE64_32_BYTES = Buffer.alloc(32, 0x42).toString("base64");
// 31 bytes — one short.
const BASE64_31_BYTES = Buffer.alloc(31, 0x42).toString("base64");
// 33 bytes — one long.
const BASE64_33_BYTES = Buffer.alloc(33, 0x42).toString("base64");

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "opencoo-key-"));
}

describe("loadEncryptionKey — precedence", () => {
  it("prefers ENCRYPTION_KEY_FILE when both are set", () => {
    const dir = mktemp();
    const filePath = join(dir, "key");
    const fileBytes = Buffer.alloc(32, 0x77).toString("base64");
    writeFileSync(filePath, fileBytes);
    try {
      const env = {
        ENCRYPTION_KEY: BASE64_32_BYTES,
        ENCRYPTION_KEY_FILE: filePath,
      };
      const key = loadEncryptionKey(env);
      expect(key.length).toBe(32);
      expect(key[0]).toBe(0x77);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls through to ENCRYPTION_KEY when _FILE unset", () => {
    const env = { ENCRYPTION_KEY: BASE64_32_BYTES };
    const key = loadEncryptionKey(env);
    expect(key.length).toBe(32);
    expect(key[0]).toBe(0x42);
  });

  it("throws ConfigError when both are missing", () => {
    expect(() => loadEncryptionKey({})).toThrow(ConfigError);
  });

  it("throws ConfigError when both are empty strings", () => {
    expect(() => loadEncryptionKey({ ENCRYPTION_KEY: "", ENCRYPTION_KEY_FILE: "" })).toThrow(ConfigError);
  });
});

describe("loadEncryptionKey — length validation", () => {
  it("throws when base64 decodes to 31 bytes (short)", () => {
    expect(() => loadEncryptionKey({ ENCRYPTION_KEY: BASE64_31_BYTES })).toThrow(
      ConfigError,
    );
  });

  it("throws when base64 decodes to 33 bytes (long)", () => {
    expect(() => loadEncryptionKey({ ENCRYPTION_KEY: BASE64_33_BYTES })).toThrow(
      ConfigError,
    );
  });

  it("throws when ENCRYPTION_KEY is a 64-char hex string (common mistake — decodes to 48 bytes as base64)", () => {
    const hex64 = "a".repeat(64);
    expect(() => loadEncryptionKey({ ENCRYPTION_KEY: hex64 })).toThrow(
      ConfigError,
    );
  });

  it("throws when ENCRYPTION_KEY is obvious garbage", () => {
    expect(() => loadEncryptionKey({ ENCRYPTION_KEY: "not-valid-base64!!" })).toThrow(
      ConfigError,
    );
  });
});

describe("loadEncryptionKey — file-mode edge cases", () => {
  it("throws when ENCRYPTION_KEY_FILE points at an empty file", () => {
    const dir = mktemp();
    const filePath = join(dir, "empty");
    writeFileSync(filePath, "");
    try {
      expect(() => loadEncryptionKey({ ENCRYPTION_KEY_FILE: filePath })).toThrow(
        ConfigError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trims a trailing newline from the key file (common with `echo` redirects)", () => {
    const dir = mktemp();
    const filePath = join(dir, "key");
    writeFileSync(filePath, BASE64_32_BYTES + "\n");
    try {
      const key = loadEncryptionKey({ ENCRYPTION_KEY_FILE: filePath });
      expect(key.length).toBe(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trims surrounding whitespace from the key file", () => {
    const dir = mktemp();
    const filePath = join(dir, "key");
    writeFileSync(filePath, `  ${BASE64_32_BYTES}\n\n`);
    try {
      const key = loadEncryptionKey({ ENCRYPTION_KEY_FILE: filePath });
      expect(key.length).toBe(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
