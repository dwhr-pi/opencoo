/**
 * Boot-time config validator. The engine reads exactly the env vars
 * on the no-feature-env-vars allowlist (DATABASE_URL, REDIS_URL,
 * GITEA_URL, PORT, LOG_LEVEL, NODE_ENV, plus their `_FILE` Docker-
 * secrets variants). Anything else is a feature flag and belongs in
 * Postgres-managed config (UI-first principle).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadEngineConfig } from "../src/config.js";

describe("loadEngineConfig — happy path", () => {
  it("returns a fully-typed config when every required env var is set", () => {
    const config = loadEngineConfig({
      DATABASE_URL: "postgres://localhost/opencoo_test",
      REDIS_URL: "redis://localhost:6379",
      GITEA_URL: "https://gitea.test",
      PORT: "8080",
      LOG_LEVEL: "info",
      NODE_ENV: "production",
    });
    expect(config.databaseUrl).toBe("postgres://localhost/opencoo_test");
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.giteaUrl).toBe("https://gitea.test");
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("info");
    expect(config.nodeEnv).toBe("production");
  });

  it("PORT defaults to 8080 when absent", () => {
    const config = loadEngineConfig({
      DATABASE_URL: "postgres://localhost/opencoo_test",
      REDIS_URL: "redis://localhost:6379",
      GITEA_URL: "https://gitea.test",
    });
    expect(config.port).toBe(8080);
  });

  it("LOG_LEVEL defaults to 'info' when absent", () => {
    const config = loadEngineConfig({
      DATABASE_URL: "postgres://localhost/opencoo_test",
      REDIS_URL: "redis://localhost:6379",
      GITEA_URL: "https://gitea.test",
    });
    expect(config.logLevel).toBe("info");
  });

  it("NODE_ENV defaults to 'development' when absent", () => {
    const config = loadEngineConfig({
      DATABASE_URL: "postgres://localhost/opencoo_test",
      REDIS_URL: "redis://localhost:6379",
      GITEA_URL: "https://gitea.test",
    });
    expect(config.nodeEnv).toBe("development");
  });
});

describe("loadEngineConfig — _FILE convention", () => {
  it("reads DATABASE_URL_FILE / REDIS_URL_FILE / GITEA_URL_FILE from disk when set", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cfg-"));
    const dbFile = path.join(tmp, "db");
    const redisFile = path.join(tmp, "redis");
    const giteaFile = path.join(tmp, "gitea");
    fs.writeFileSync(dbFile, "postgres://from-file/opencoo\n");
    fs.writeFileSync(redisFile, "redis://from-file:6379\n");
    fs.writeFileSync(giteaFile, "https://gitea-from-file.test\n");

    const config = loadEngineConfig({
      DATABASE_URL_FILE: dbFile,
      REDIS_URL_FILE: redisFile,
      GITEA_URL_FILE: giteaFile,
    });
    // Trailing newline must be stripped — the file convention writes
    // values terminated by `\n` for easy `printf | tee` on Docker
    // entrypoints.
    expect(config.databaseUrl).toBe("postgres://from-file/opencoo");
    expect(config.redisUrl).toBe("redis://from-file:6379");
    expect(config.giteaUrl).toBe("https://gitea-from-file.test");
  });

  it("_FILE wins when both DATABASE_URL and DATABASE_URL_FILE are set (Docker-secrets convention)", () => {
    // Repo convention from .env.example + loadEncryptionKey:
    //   `_FILE` variants take precedence — the Docker-secrets
    //   pattern stashes the real secret on a tmpfs path and the
    //   inline var is typically a development fallback. Setting
    //   both is a misconfig, but in production the safe answer is
    //   to honour the file-mounted secret over a stale inline.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-cfg-"));
    const dbFile = path.join(tmp, "db");
    fs.writeFileSync(dbFile, "postgres://from-file/opencoo");
    const config = loadEngineConfig({
      DATABASE_URL: "postgres://inline/opencoo",
      DATABASE_URL_FILE: dbFile,
      REDIS_URL: "redis://localhost:6379",
      GITEA_URL: "https://gitea.test",
    });
    expect(config.databaseUrl).toBe("postgres://from-file/opencoo");
  });
});

describe("loadEngineConfig — validation failures", () => {
  it("throws when DATABASE_URL is missing", () => {
    expect(() =>
      loadEngineConfig({
        REDIS_URL: "redis://localhost:6379",
        GITEA_URL: "https://gitea.test",
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it("throws when REDIS_URL is missing", () => {
    expect(() =>
      loadEngineConfig({
        DATABASE_URL: "postgres://localhost/opencoo_test",
        GITEA_URL: "https://gitea.test",
      }),
    ).toThrow(/REDIS_URL/);
  });

  it("throws when GITEA_URL is missing", () => {
    expect(() =>
      loadEngineConfig({
        DATABASE_URL: "postgres://localhost/opencoo_test",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow(/GITEA_URL/);
  });

  it("throws when GITEA_URL is not a valid URL", () => {
    expect(() =>
      loadEngineConfig({
        DATABASE_URL: "postgres://localhost/opencoo_test",
        REDIS_URL: "redis://localhost:6379",
        GITEA_URL: "not-a-url",
      }),
    ).toThrow();
  });

  it("throws when PORT is non-numeric", () => {
    expect(() =>
      loadEngineConfig({
        DATABASE_URL: "postgres://localhost/opencoo_test",
        REDIS_URL: "redis://localhost:6379",
        GITEA_URL: "https://gitea.test",
        PORT: "not-a-number",
      }),
    ).toThrow();
  });

  it("throws when LOG_LEVEL is invalid", () => {
    expect(() =>
      loadEngineConfig({
        DATABASE_URL: "postgres://localhost/opencoo_test",
        REDIS_URL: "redis://localhost:6379",
        GITEA_URL: "https://gitea.test",
        LOG_LEVEL: "trace",
      }),
    ).toThrow();
  });

  it("throws when DATABASE_URL_FILE points at a non-existent path", () => {
    expect(() =>
      loadEngineConfig({
        DATABASE_URL_FILE: "/no/such/path/12345",
        REDIS_URL: "redis://localhost:6379",
        GITEA_URL: "https://gitea.test",
      }),
    ).toThrow();
  });
});
