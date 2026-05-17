/**
 * Company-aggregator integration test (PR 22 / plan #106).
 *
 * Drives `compileCompanyWorldview` against a wiki seeded with
 * pages from multiple non-aggregator domains and asserts the
 * sovereignty constraint via the SovereigntySpyWikiAdapter:
 * if the compiler tried to read anything other than
 * 'worldview.md' from a non-aggregator domain, the spy throws.
 *
 * Also exercises the token-cap retry path: a small first-pass
 * payload returns success; a 25 KB first-pass payload fails
 * Zod, the retry returns a small payload, success with
 * `retried: true`; both passes oversized → WorldviewOverflowError.
 */
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import { LlmRouter, type LlmProvider } from "@opencoo/shared/llm-router";
import type { DomainId, DomainSlug } from "@opencoo/shared/db";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";

import {
  SOVEREIGN_AGGREGATOR_INPUT_PATH,
  SovereigntySpyWikiAdapter,
  WORLDVIEW_BODY_MAX_BYTES,
  WorldviewOverflowError,
  compileCompanyWorldview,
} from "../../../src/pipelines/worldview/index.js";

import { freshAgentDb } from "../../agent-harness/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({ stream: { write: (): boolean => true } });
}

function fakeProvider(
  responses: ReadonlyArray<unknown>,
): LlmProvider {
  let i = 0;
  return {
    generate: async () => {
      const r = responses[i] ?? responses[responses.length - 1];
      i++;
      return {
        text: typeof r === "string" ? r : JSON.stringify(r),
        tokensIn: 5,
        tokensOut: 5,
      };
    },
  };
}

function makeRouter(provider: LlmProvider, db: unknown): LlmRouter {
  return new LlmRouter({
    db: db as Parameters<typeof LlmRouter>[0]["db"],
    env: {},
    logger: silentLogger(),
    pauser: {
      paused: () => false,
      pause: () => undefined,
      resume: () => undefined,
    },
    provider,
  });
}

function seedWiki(): InMemoryWikiAdapter {
  const wiki = new InMemoryWikiAdapter();
  // Two non-aggregator domains, each with worldview.md + a few
  // OTHER pages the aggregator must NOT read.
  wiki.inject("exec" as DomainSlug, "worldview.md", "# exec worldview");
  wiki.inject("exec" as DomainSlug, "team/eng.md", "# eng team");
  wiki.inject("exec" as DomainSlug, "projects/q3.md", "# q3");
  wiki.inject("hr" as DomainSlug, "worldview.md", "# hr worldview");
  wiki.inject("hr" as DomainSlug, "policies/leave.md", "# leave");
  return wiki;
}

describe("compileCompanyWorldview — sovereignty + token-cap", () => {
  it("reads ONLY worldview.md from non-aggregator domains; spy logs no violations", async () => {
    const fixture = await freshAgentDb();
    // Mark fixture's domain as aggregator and add the two non-
    // aggregator domains.
    await fixture.raw.query(
      `UPDATE domains SET slug = 'company', is_aggregator = true WHERE id = $1::uuid`,
      [fixture.domainId],
    );
    await fixture.raw.query(
      `INSERT INTO domains (slug, name) VALUES ('exec', 'Exec'), ('hr', 'HR')`,
    );

    const wiki = seedWiki();
    const spy = new SovereigntySpyWikiAdapter({
      inner: wiki,
      aggregatorOwnSlug: "company",
    });
    const router = makeRouter(
      fakeProvider([
        { version: "v1", body: "# company\nrolled-up summary." },
      ]),
      fixture.db,
    );

    const result = await compileCompanyWorldview({
      router,
      wikiAdapter: spy,
      db: fixture.db as unknown as Parameters<typeof compileCompanyWorldview>[0]["db"],
      aggregatorDomainId: fixture.domainId as DomainId,
      nonAggregatorDomainSlugs: [
        "exec" as DomainSlug,
        "hr" as DomainSlug,
      ],
      locale: "en",
    });

    expect(result.body).toContain("rolled-up summary");
    expect(result.retried).toBe(false);
    expect(result.contributingSlugs).toEqual(["exec", "hr"]);
    // The spy logs no violations — the compiler only ever asked
    // for 'worldview.md'.
    expect(spy.violationLog).toEqual([]);
  });

  it("retries once with 'compress further' suffix when first response overflows", async () => {
    const fixture = await freshAgentDb();
    await fixture.raw.query(
      `UPDATE domains SET slug = 'company', is_aggregator = true WHERE id = $1::uuid`,
      [fixture.domainId],
    );
    await fixture.raw.query(
      `INSERT INTO domains (slug, name) VALUES ('exec', 'Exec')`,
    );

    const wiki = seedWiki();
    const spy = new SovereigntySpyWikiAdapter({
      inner: wiki,
      aggregatorOwnSlug: "company",
    });

    // First response: oversized body. Second response:
    // compressed body. The compiler returns retried=true.
    const oversized = "x".repeat(WORLDVIEW_BODY_MAX_BYTES + 100);
    const router = makeRouter(
      fakeProvider([
        { version: "v1", body: oversized },
        { version: "v1", body: "# company\ncompressed." },
      ]),
      fixture.db,
    );

    const result = await compileCompanyWorldview({
      router,
      wikiAdapter: spy,
      db: fixture.db as unknown as Parameters<typeof compileCompanyWorldview>[0]["db"],
      aggregatorDomainId: fixture.domainId as DomainId,
      nonAggregatorDomainSlugs: ["exec" as DomainSlug],
      locale: "en",
    });

    expect(result.retried).toBe(true);
    expect(result.body).toContain("compressed");
  });

  it("throws WorldviewOverflowError when both attempts overflow", async () => {
    const fixture = await freshAgentDb();
    await fixture.raw.query(
      `UPDATE domains SET slug = 'company', is_aggregator = true WHERE id = $1::uuid`,
      [fixture.domainId],
    );
    await fixture.raw.query(
      `INSERT INTO domains (slug, name) VALUES ('exec', 'Exec')`,
    );

    const wiki = seedWiki();
    const spy = new SovereigntySpyWikiAdapter({
      inner: wiki,
      aggregatorOwnSlug: "company",
    });

    const oversized = "x".repeat(WORLDVIEW_BODY_MAX_BYTES + 100);
    const router = makeRouter(
      fakeProvider([
        { version: "v1", body: oversized },
        { version: "v1", body: oversized },
      ]),
      fixture.db,
    );

    await expect(
      compileCompanyWorldview({
        router,
        wikiAdapter: spy,
        db: fixture.db as unknown as Parameters<typeof compileCompanyWorldview>[0]["db"],
        aggregatorDomainId: fixture.domainId as DomainId,
        nonAggregatorDomainSlugs: ["exec" as DomainSlug],
        locale: "en",
      }),
    ).rejects.toBeInstanceOf(WorldviewOverflowError);
  });

  it("skips non-aggregator domains whose worldview.md doesn't exist yet", async () => {
    const fixture = await freshAgentDb();
    await fixture.raw.query(
      `UPDATE domains SET slug = 'company', is_aggregator = true WHERE id = $1::uuid`,
      [fixture.domainId],
    );
    await fixture.raw.query(
      `INSERT INTO domains (slug, name) VALUES ('exec', 'Exec'), ('virgin', 'Virgin')`,
    );

    const wiki = seedWiki();
    // 'virgin' has no pages at all — wiki.readPage returns null.
    const spy = new SovereigntySpyWikiAdapter({
      inner: wiki,
      aggregatorOwnSlug: "company",
    });
    const router = makeRouter(
      fakeProvider([{ version: "v1", body: "# company\nfrom exec only." }]),
      fixture.db,
    );

    const result = await compileCompanyWorldview({
      router,
      wikiAdapter: spy,
      db: fixture.db as unknown as Parameters<typeof compileCompanyWorldview>[0]["db"],
      aggregatorDomainId: fixture.domainId as DomainId,
      nonAggregatorDomainSlugs: [
        "exec" as DomainSlug,
        "virgin" as DomainSlug,
      ],
      locale: "en",
    });
    // Virgin contributed nothing; only exec is in the list.
    expect(result.contributingSlugs).toEqual(["exec"]);
  });

  it("expects the SOVEREIGN_AGGREGATOR_INPUT_PATH to be 'worldview.md' (regression guard)", () => {
    expect(SOVEREIGN_AGGREGATOR_INPUT_PATH).toBe("worldview.md");
  });
});
