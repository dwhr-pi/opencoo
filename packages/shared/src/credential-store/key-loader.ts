import { readFileSync } from "node:fs";

import { ConfigError } from "./errors.js";

const REQUIRED_KEY_BYTES = 32;

// Load the 32-byte symmetric key the CredentialStore uses for AES-256-GCM.
// Precedence: `ENCRYPTION_KEY_FILE` (Docker secrets pattern) > `ENCRYPTION_KEY`.
// Accepts base64-encoded input; decodes and strictly validates the byte
// length. An `env` record must be passed explicitly — NEVER falls back
// to `process.env` so tests stay hermetic (a stale key in the dev shell
// cannot mask a regression).
export function loadEncryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const filePath = env["ENCRYPTION_KEY_FILE"];
  const inline = env["ENCRYPTION_KEY"];

  let raw: string;
  if (filePath !== undefined && filePath !== "") {
    raw = readFileSync(filePath, "utf8").trim();
    if (raw === "") {
      throw new ConfigError(
        `ENCRYPTION_KEY_FILE at ${filePath} is empty — write a base64-encoded 32-byte key.`,
      );
    }
  } else if (inline !== undefined && inline !== "") {
    raw = inline.trim();
  } else {
    throw new ConfigError(
      "ENCRYPTION_KEY missing — set ENCRYPTION_KEY or ENCRYPTION_KEY_FILE to a base64-encoded 32-byte key.",
    );
  }

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== REQUIRED_KEY_BYTES) {
    throw new ConfigError(
      `ENCRYPTION_KEY must decode (base64) to exactly ${REQUIRED_KEY_BYTES} bytes; got ${decoded.length}. ` +
        `Generate with: openssl rand -base64 32`,
    );
  }
  return decoded;
}
