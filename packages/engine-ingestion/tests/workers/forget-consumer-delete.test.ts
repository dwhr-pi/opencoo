/**
 * Forget consumer — delete worker (PR-W6, phase-a appendix #11
 * follow-up #65 + Issue 2 fix-up).
 *
 * Pinned behaviors:
 *   1. Job processed → wikiAdapter delete commit lands once + the
 *      forgotten binding's page_citations row(s) are pruned.
 *   2. The page is deleted via wikiWrite with `caller.kind = 'admin'`
 *      so we do NOT double-reserve the daily cap (the route already
 *      reserved before enqueueing — wiki-write.ts:96 admin-bypass
 *      contract enforces this).
 *   3. A wikiWrite failure (cap exceeded mid-run, transport blip)
 *      re-throws so BullMQ retries on the next tick.
 *   4. Defensive: a page that's already gone (concurrent forget,
 *      manual delete) → no wiki write attempt + warn log + still
 *      prune any orphan citation rows for the forgotten binding.
 *   5. Issue 2 race: another binding added a citation between plan
 *      + consume (e.g. fresh ingestion landed a new binding's row
 *      after the planner snapshot). The worker prunes ONLY the
 *      forgotten binding's row, detects a surviving citation, logs
 *      `delete.race_detected`, and SKIPS the wiki delete. The other
 *      binding now owns the page; deleting it would destroy that
 *      binding's contributions.
 */
import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "@opencoo/shared/logger";
import type { ForgetJobPayload } from "@opencoo/shared/forget";
import {
  InMemoryDeleteCap,
  InMemoryWikiWriteQueue,
  WikiWriteCapExceededError,
  type WikiWriteDeps,
} from "@opencoo/shared/wiki-write";
import { InMemoryWikiAdapter } from "@opencoo/shared/wiki-write/testing";
import type { DomainSlug } from "@opencoo/shared/db";

import {
  buildForgetDeleteHandler,
  type ForgetDeleteDeps,
} from "../../src/workers/forget-consumer.js";

import { freshPipelineDb } from "../pipelines/_pglite-fixture.js";

function silentLogger(): ConsoleLogger {
  return new ConsoleLogger({
    stream: { write: (): boolean => true },
  });
}

const AUTHOR = {
  name: "opencoo-test",
  email: "test@opencoo.local",
} as const;

function fakeJob(data: ForgetJobPayload): Job<ForgetJobPayload> {
  return {
    id: "job-1",
    name: "delete_page",
    data,
    queueName: "wiki.delete",
    attemptsMade: 0,
    timestamp: Date.now(),
  } as unknown as Job<ForgetJobPayload>;
}

async function insertCitation(
  raw: import("@electric-sql/pglite").PGlite,
  args: {
    domainSlug: string;
    pagePath: string;
    sourceBindingId: string;
    sourceRef: string;
  },
): Promise<void> {
  await raw.query(
    `INSERT INTO page_citations
       (domain_slug, page_path, source_binding_id, source_ref, prompt_version)
     VALUES ($1, $2, $3::uuid, $4, $5)`,
    [
      args.domainSlug,
      args.pagePath,
      args.sourceBindingId,
      args.sourceRef,
      "compiler@v1",
    ],
  );
}

async function insertExtraBinding(
  raw: import("@electric-sql/pglite").PGlite,
  domainId: string,
  adapterSlug: string,
): Promise<string> {
  const result = await raw.query<{ id: string }>(
    `INSERT INTO sources_bindings (domain_id, adapter_slug, allowed_paths)
     VALUES ($1, $2, $3) RETURNING id`,
    [domainId, adapterSlug, ["strategy/**"]],
  );
  return result.rows[0]!.id;
}

interface Fixture {
  readonly adapter: InMemoryWikiAdapter;
  readonly cap: InMemoryDeleteCap;
  readonly logs: string[];
  readonly deps: ForgetDeleteDeps;
  readonly db: Awaited<ReturnType<typeof freshPipelineDb>>;
}

async function makeFixture(
  capLimit?: number,
): Promise<Fixture> {
  const db = await freshPipelineDb();
  const adapter = new InMemoryWikiAdapter();
  const cap =
    capLimit !== undefined
      ? new InMemoryDeleteCap({ dailyLimit: capLimit })
      : new InMemoryDeleteCap();
  const logs: string[] = [];
  const captureLogger = new ConsoleLogger({
    stream: {
      write: (chunk: string): boolean => {
        logs.push(chunk);
        return true;
      },
    },
  });
  const wikiDeps: WikiWriteDeps = {
    adapter,
    queue: new InMemoryWikiWriteQueue(),
    deleteCap: cap,
    logger: silentLogger(),
    clock: (): Date => new Date("2026-04-25T12:00:00Z"),
    instanceId: "test-instance",
  };
  const deps: ForgetDeleteDeps = {
    db: db.db as unknown as ForgetDeleteDeps["db"],
    logger: captureLogger,
    wikiDeps,
    author: AUTHOR,
  };
  return { adapter, cap, logs, deps, db };
}

describe("buildForgetDeleteHandler", () => {
  it("deletes the wiki page once + clears page_citations + does NOT consume cap budget", async () => {
    const f = await makeFixture();
    const PAGE = "strategy/orphan.md";

    // Seed the page in the wiki + a citation row referencing the
    // forgotten binding.
    f.adapter.inject(
      "test-domain" as DomainSlug,
      PAGE,
      "# Orphan\n\nForgotten content.\n",
    );
    await insertCitation(f.db.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: f.db.bindingId,
      sourceRef: "drive:doc-orphan",
    });

    const handler = buildForgetDeleteHandler(f.deps);
    await handler(
      fakeJob({
        bindingId: f.db.bindingId,
        domainSlug: "test-domain",
        pagePath: PAGE,
        callerUsername: "alice",
      }),
    );

    // 1) Wiki page is gone.
    const after = await f.adapter.readPage("test-domain" as DomainSlug, PAGE);
    expect(after).toBeNull();

    // 2) page_citations row(s) for this page are pruned.
    const remaining = await f.db.raw.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM page_citations
       WHERE domain_slug = $1 AND page_path = $2`,
      ["test-domain", PAGE],
    );
    expect(Number.parseInt(remaining.rows[0]!.count, 10)).toBe(0);

    // 3) Cap budget is NOT consumed by the worker — the route
    //    already reserved before enqueueing. wikiWrite's admin-
    //    bypass contract (wiki-write.ts:96) keeps `used` at 0 here.
    const capState = f.cap.peek(
      "test-domain" as DomainSlug,
      new Date("2026-04-25T12:00:00Z"),
    );
    expect(capState.used).toBe(0);
  });

  it("re-throws when wikiWrite fails (so BullMQ retries on a future tick)", async () => {
    // We force a failure by saturating the cap and then forcing the
    // worker to use an `engine` caller — but the worker's contract
    // is admin-caller, so we instead simulate a wikiWrite failure
    // by replacing the adapter with one that throws on writeAtomic.
    const f = await makeFixture();
    const PAGE = "strategy/will-fail.md";
    f.adapter.inject(
      "test-domain" as DomainSlug,
      PAGE,
      "# Fail\n",
    );
    await insertCitation(f.db.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: f.db.bindingId,
      sourceRef: "drive:doc-fail",
    });

    // Replace the adapter's writeAtomic with a thrower while keeping
    // readPage live (so the existence probe still returns the page).
    const originalAdapter = f.deps.wikiDeps.adapter;
    const failingAdapter = {
      getHeadSha: originalAdapter.getHeadSha.bind(originalAdapter),
      readPage: originalAdapter.readPage.bind(originalAdapter),
      listMarkdown: originalAdapter.listMarkdown.bind(originalAdapter),
      writeAtomic: async () => {
        throw new WikiWriteCapExceededError(
          "wiki-write delete cap exceeded for test-domain: 10+1 > 10 on 2026-04-25",
        );
      },
    };
    const failingDeps: ForgetDeleteDeps = {
      ...f.deps,
      wikiDeps: { ...f.deps.wikiDeps, adapter: failingAdapter },
    };
    const handler = buildForgetDeleteHandler(failingDeps);
    await expect(
      handler(
        fakeJob({
          bindingId: f.db.bindingId,
          domainSlug: "test-domain",
          pagePath: PAGE,
          callerUsername: "alice",
        }),
      ),
    ).rejects.toThrow(/wiki-write delete cap exceeded/);
  });

  it("no-ops with a warn log when the page is already gone (defensive)", async () => {
    // Concurrent forget / manual delete / retry of THIS job that
    // landed the wiki commit then crashed before db prune. The
    // worker still clears any orphan citation row + warns.
    const f = await makeFixture();
    const PAGE = "strategy/already-gone.md";
    // No `inject` — page does not exist in the wiki.
    await insertCitation(f.db.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: f.db.bindingId,
      sourceRef: "drive:doc-orphan-row",
    });

    const handler = buildForgetDeleteHandler(f.deps);
    await handler(
      fakeJob({
        bindingId: f.db.bindingId,
        domainSlug: "test-domain",
        pagePath: PAGE,
        callerUsername: "alice",
      }),
    );

    // Citation row pruned even though the page itself was missing.
    const remaining = await f.db.raw.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM page_citations
       WHERE domain_slug = $1 AND page_path = $2`,
      ["test-domain", PAGE],
    );
    expect(Number.parseInt(remaining.rows[0]!.count, 10)).toBe(0);

    // Warn log emitted.
    const joined = f.logs.join("");
    expect(joined).toContain("forget_consumer.delete.page_already_gone");
    expect(joined).toContain(PAGE);

    // Cap budget untouched (no wiki write happened).
    const capState = f.cap.peek(
      "test-domain" as DomainSlug,
      new Date("2026-04-25T12:00:00Z"),
    );
    expect(capState.used).toBe(0);
  });

  it("admin-caller bypass works even when cap is exhausted (route already reserved at enqueue)", async () => {
    // Models the W1 enqueue contract end-to-end: the admin-API
    // forget route reserved the daily delete-cap budget BEFORE
    // enqueueing the job, then the worker runs with caller.kind =
    // 'admin' so it does NOT double-reserve. Construct the fixture
    // with `dailyLimit: 0` — any non-admin caller would throw
    // `WikiWriteCapExceededError` immediately, but the worker's
    // admin caller flows past the cap check (wiki-write.ts:96
    // `caller.kind !== 'admin'` branch is skipped) and the delete
    // commits.
    const f = await makeFixture(0);
    const PAGE = "strategy/cap-exhausted.md";
    f.adapter.inject(
      "test-domain" as DomainSlug,
      PAGE,
      "# Cap-exhausted\n",
    );
    await insertCitation(f.db.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: f.db.bindingId,
      sourceRef: "drive:doc-cap-exhausted",
    });

    const handler = buildForgetDeleteHandler(f.deps);
    await handler(
      fakeJob({
        bindingId: f.db.bindingId,
        domainSlug: "test-domain",
        pagePath: PAGE,
        callerUsername: "alice",
      }),
    );

    // 1) Wiki page is gone — admin bypass took effect.
    const after = await f.adapter.readPage("test-domain" as DomainSlug, PAGE);
    expect(after).toBeNull();

    // 2) Cap state still shows used: 0 — admin caller does not
    //    consume budget (matches the route-reserves-once contract).
    const capState = f.cap.peek(
      "test-domain" as DomainSlug,
      new Date("2026-04-25T12:00:00Z"),
    );
    expect(capState.used).toBe(0);
    expect(capState.cap).toBe(0);
  });

  it("only deletes the named page — leaves other pages in the same domain intact", async () => {
    const f = await makeFixture();
    const TARGET = "strategy/target.md";
    const SIBLING = "strategy/sibling.md";
    f.adapter.inject(
      "test-domain" as DomainSlug,
      TARGET,
      "# Target\n",
    );
    f.adapter.inject(
      "test-domain" as DomainSlug,
      SIBLING,
      "# Sibling\n",
    );
    await insertCitation(f.db.raw, {
      domainSlug: "test-domain",
      pagePath: TARGET,
      sourceBindingId: f.db.bindingId,
      sourceRef: "drive:target",
    });
    await insertCitation(f.db.raw, {
      domainSlug: "test-domain",
      pagePath: SIBLING,
      sourceBindingId: f.db.bindingId,
      sourceRef: "drive:sibling",
    });

    const handler = buildForgetDeleteHandler(f.deps);
    await handler(
      fakeJob({
        bindingId: f.db.bindingId,
        domainSlug: "test-domain",
        pagePath: TARGET,
        callerUsername: "alice",
      }),
    );

    // Target gone, sibling still present.
    expect(
      await f.adapter.readPage("test-domain" as DomainSlug, TARGET),
    ).toBeNull();
    const sibling = await f.adapter.readPage(
      "test-domain" as DomainSlug,
      SIBLING,
    );
    expect(sibling).not.toBeNull();
    expect(sibling!.content).toContain("Sibling");

    // Sibling's citation row also intact.
    const siblingRows = await f.db.raw.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM page_citations
       WHERE domain_slug = $1 AND page_path = $2`,
      ["test-domain", SIBLING],
    );
    expect(Number.parseInt(siblingRows.rows[0]!.count, 10)).toBe(1);
  });

  it("Issue 2 race: skips wiki delete when another binding cited the page between plan + consume", async () => {
    // Race scenario: the planner snapshot saw only the forgotten
    // binding citing this page → queued a `delete_page` job. Between
    // plan-time and consume-time a fresh ingestion (or a concurrent
    // edit) added a NEW binding's citation row. Without the fix the
    // worker would blindly DELETE every page_citations row for this
    // page AND delete the wiki page, destroying the new binding's
    // contributions and leaving its source pointing at a 404.
    //
    // Fix: scope the prune to ONLY the forgotten binding's row(s);
    // probe for any survivor; if any survive, log race-detected and
    // SKIP the wiki delete. The other binding now owns the page;
    // the engine's next compile / forget tick from that binding
    // will refresh or remove it.
    const f = await makeFixture();
    const otherBinding = await insertExtraBinding(
      f.db.raw,
      f.db.domainId,
      "asana",
    );
    const PAGE = "strategy/contested.md";
    f.adapter.inject(
      "test-domain" as DomainSlug,
      PAGE,
      "# Contested\n\nForgotten + new content.\n",
    );
    // Forgotten binding's row (planner snapshot saw this).
    await insertCitation(f.db.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: f.db.bindingId,
      sourceRef: "drive:doc-forgotten",
    });
    // Other binding's row added BETWEEN plan-time and consume-time
    // (test stand-in for the race window).
    await insertCitation(f.db.raw, {
      domainSlug: "test-domain",
      pagePath: PAGE,
      sourceBindingId: otherBinding,
      sourceRef: "asana:project-fresh",
    });

    const handler = buildForgetDeleteHandler(f.deps);
    await handler(
      fakeJob({
        bindingId: f.db.bindingId,
        domainSlug: "test-domain",
        pagePath: PAGE,
        callerUsername: "alice",
      }),
    );

    // 1) Wiki page is STILL THERE — race-detected; skip delete.
    const stillThere = await f.adapter.readPage(
      "test-domain" as DomainSlug,
      PAGE,
    );
    expect(stillThere).not.toBeNull();
    expect(stillThere!.content).toContain("Contested");

    // 2) Forgotten binding's citation row is GONE (scoped prune
    //    succeeded — that's the binding-specific erasure contract).
    const remainingForgotten = await f.db.raw.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM page_citations
       WHERE domain_slug = $1
         AND page_path = $2
         AND source_binding_id = $3::uuid`,
      ["test-domain", PAGE, f.db.bindingId],
    );
    expect(Number.parseInt(remainingForgotten.rows[0]!.count, 10)).toBe(0);

    // 3) The OTHER binding's citation row SURVIVES — that's the
    //    contribution we must preserve.
    const survivingOther = await f.db.raw.query<{
      source_ref: string;
    }>(
      `SELECT source_ref FROM page_citations
       WHERE domain_slug = $1
         AND page_path = $2
         AND source_binding_id = $3::uuid`,
      ["test-domain", PAGE, otherBinding],
    );
    expect(survivingOther.rows).toHaveLength(1);
    expect(survivingOther.rows[0]!.source_ref).toBe("asana:project-fresh");

    // 4) Race-detected log emitted.
    const joined = f.logs.join("");
    expect(joined).toContain("forget_consumer.delete.race_detected");
    expect(joined).toContain(PAGE);
    expect(joined).toContain("surviving_citation_count");
  });
});
