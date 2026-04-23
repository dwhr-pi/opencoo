import { RuleTester } from "@typescript-eslint/rule-tester";
import * as tseslintParser from "@typescript-eslint/parser";

import { noUpdateAppendOnly } from "../src/rules/no-update-append-only.js";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslintParser,
    parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
});

ruleTester.run("no-update-append-only", noUpdateAppendOnly, {
  valid: [
    {
      name: "update on a mutation-adjacent table (domains) is fine",
      code: `db.update(domains).set({ name: 'x' });`,
    },
    {
      name: "update on agent_instances (mutation-adjacent) is fine",
      code: `db.update(agentInstances).set({ enabled: false });`,
    },
    {
      name: "update on catalog_candidate (mutation-adjacent carve-out) is fine",
      code: `db.update(catalogCandidate).set({ status: 'drafted' });`,
    },
    {
      name: "SELECT from an append-only table is fine",
      code: `db.select().from(agentRuns);`,
    },
    {
      name: "INSERT into an append-only table is fine (it's the allowed path)",
      code: `db.insert(pageCitations).values({ domainSlug: 'x', pagePath: 'y' });`,
    },
    {
      name: "delete on a mutation-adjacent table is fine",
      code: `db.delete(domains).where(true);`,
    },
    {
      name: "update on an arbitrary non-schema identifier is ignored",
      code: `someBuilder.update(foo).set({ bar: 1 });`,
    },
  ],
  invalid: [
    {
      name: "update on agent_runs flags updateAppendOnly",
      code: `db.update(agentRuns).set({ status: 'success' });`,
      errors: [{ messageId: "updateAppendOnly", data: { table: "agentRuns" } }],
    },
    {
      name: "delete on page_citations flags deleteAppendOnly",
      code: `db.delete(pageCitations);`,
      errors: [
        { messageId: "deleteAppendOnly", data: { table: "pageCitations" } },
      ],
    },
    {
      name: "chain case: db.with(cte).update(redactionEvents) flags",
      code: `db.with(cte).update(redactionEvents).set({ a: 1 });`,
      errors: [
        { messageId: "updateAppendOnly", data: { table: "redactionEvents" } },
      ],
    },
    {
      name: "update on erasureLog with a where clause still flags",
      code: `db.update(erasureLog).where(true);`,
      errors: [{ messageId: "updateAppendOnly", data: { table: "erasureLog" } }],
    },
    {
      name: "delete on minerSuppressions flags",
      code: `db.delete(minerSuppressions);`,
      errors: [
        { messageId: "deleteAppendOnly", data: { table: "minerSuppressions" } },
      ],
    },
    {
      name: "chain case with transaction handle: tx.update(agentRuns) flags",
      code: `tx.update(agentRuns).set({ status: 'failed' });`,
      errors: [{ messageId: "updateAppendOnly", data: { table: "agentRuns" } }],
    },
  ],
});
