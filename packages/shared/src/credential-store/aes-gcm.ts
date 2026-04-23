import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import {
  IntegrityError,
  UnsupportedEncryptionVersionError,
} from "./errors.js";

// Version byte stamped on every write and checked on every read. Bumped
// when the algorithm or wire shape changes (e.g. a future V2 might
// switch to ChaCha20-Poly1305 or add a KMS wrapping layer). Old-version
// reads continue via `decryptVersion`; writes always use CURRENT_VERSION.
export const CURRENT_VERSION = 1;

const ALGORITHM_V1 = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptResult {
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
}

// Encrypt `plaintext` with AES-256-GCM, binding `aad` via the AEAD
// channel. Returns a fresh random IV plus `ciphertext = body || tag`
// — the 16-byte auth tag is appended so the storage layer needs only
// one bytea column for both parts.
export function encryptV1(
  key: Buffer,
  aad: Buffer,
  plaintext: Buffer,
): EncryptResult {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM_V1, key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([body, tag]);
  return { iv, ciphertext };
}

// Decrypt a V1 payload. Any failure — wrong key, wrong AAD, flipped
// byte in IV/body/tag — surfaces as IntegrityError. Never leak the
// underlying node:crypto exception, which varies by platform and can
// include the plaintext in its message on older Node versions.
export function decryptV1(
  key: Buffer,
  aad: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
): Buffer {
  if (ciphertext.length < TAG_BYTES) {
    throw new IntegrityError(
      "ciphertext too short to contain an auth tag",
    );
  }
  const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM_V1, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (cause) {
    throw new IntegrityError("credential integrity check failed", { cause });
  }
}

// Dispatch a read by the persisted `encryption_version` column. Keeps
// old-version rows readable without requiring a migration batch the
// moment CURRENT_VERSION moves forward.
export function decryptVersion(
  version: number,
  key: Buffer,
  aad: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
): Buffer {
  if (version === 1) {
    return decryptV1(key, aad, iv, ciphertext);
  }
  throw new UnsupportedEncryptionVersionError(
    `encryption_version ${version} is not supported by this build`,
  );
}
