export {
  CURRENT_VERSION,
  decryptV1,
  decryptVersion,
  encryptV1,
  type EncryptResult,
} from "./aes-gcm.js";

export {
  DrizzleCredentialStore,
  type CredentialStoreDb,
  type DrizzleCredentialStoreOptions,
} from "./drizzle-store.js";

export {
  ConfigError,
  IntegrityError,
  UnsupportedEncryptionVersionError,
} from "./errors.js";

export {
  InMemoryCredentialStore,
  type InMemoryCredentialStoreOptions,
} from "./in-memory-store.js";

export {
  deriveAad,
  type CredentialInput,
  type CredentialRecord,
  type CredentialStore,
} from "./interface.js";

export { loadEncryptionKey } from "./key-loader.js";
