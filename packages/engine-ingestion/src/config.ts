/**
 * Boot-time engine configuration loader.
 *
 * Reads exactly the env vars on the no-feature-env-vars allowlist —
 * `DATABASE_URL`, `REDIS_URL`, `GITEA_URL`, `PORT`, `LOG_LEVEL`,
 * `NODE_ENV`, plus their `_FILE` Docker-secrets variants. Each
 * `_FILE` variant is read from disk with trailing-newline strip;
 * the `_FILE` form WINS when both are set (Docker-secrets pattern,
 * documented in .env.example and matching `loadEncryptionKey` from
 * @opencoo/shared). Setting both is a misconfig, but production
 * secrets are typically file-mounted via tmpfs and the inline var
 * is the development fallback — honouring the file is the safe
 * answer.
 *
 * Validation is Zod-based; missing required vars and malformed
 * values throw at boot. Callers (composition root or CLI) catch
 * the throw and exit non-zero — the loader itself never calls
 * process.exit.
 */
import fs from "node:fs";
import { z } from "zod";

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const NodeEnvSchema = z
  .enum(["development", "test", "staging", "production"])
  .default("development");

const ConfigSchema = z.object({
  databaseUrl: z.string().min(1),
  redisUrl: z.string().min(1),
  giteaUrl: z.string().url(),
  port: z.number().int().positive().max(65535).default(8080),
  logLevel: LogLevelSchema.default("info"),
  nodeEnv: NodeEnvSchema,
});

export type EngineConfig = z.infer<typeof ConfigSchema>;

/**
 * Read a value with the repo-wide `<NAME>` / `<NAME>_FILE` precedence
 * (Docker-secrets convention, .env.example:11): the `_FILE` variant
 * WINS when both are set. Reads the file at `_FILE` and strips a
 * single trailing newline run. Falls through to the inline env var
 * when `_FILE` is unset/empty. Returns `undefined` when neither is
 * set.
 */
function readWithFile(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (typeof filePath === "string" && filePath.length > 0) {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.replace(/\r?\n+$/, "");
  }
  const inline = env[name];
  if (typeof inline === "string" && inline.length > 0) {
    return inline;
  }
  return undefined;
}

/**
 * Required-variant of `readWithFile`. Throws a uniform "missing var"
 * error message naming both the inline and `_FILE` env-var names so
 * misconfigured deploys see exactly which knob to set.
 */
function requireWithFile(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = readWithFile(env, name);
  if (value === undefined) {
    throw new Error(
      `engine-ingestion config: ${name} (or ${name}_FILE) is required`,
    );
  }
  return value;
}

/**
 * Parse + validate engine config. Pure function — pass `process.env`
 * (or a stub for tests). Throws on missing required vars.
 */
export function loadEngineConfig(
  env: Record<string, string | undefined>,
): EngineConfig {
  const databaseUrl = requireWithFile(env, "DATABASE_URL");
  const redisUrl = requireWithFile(env, "REDIS_URL");
  const giteaUrl = requireWithFile(env, "GITEA_URL");

  const portRaw = env["PORT"];
  const port = portRaw === undefined ? 8080 : Number(portRaw);
  if (!Number.isFinite(port) || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      `engine-ingestion config: PORT must be a positive integer, got ${JSON.stringify(portRaw)}`,
    );
  }

  return ConfigSchema.parse({
    databaseUrl,
    redisUrl,
    giteaUrl,
    port,
    logLevel: env["LOG_LEVEL"],
    nodeEnv: env["NODE_ENV"],
  });
}
