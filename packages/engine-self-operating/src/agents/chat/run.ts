/**
 * Chat agent body — answer one user question, grounded in the
 * wiki content the user is authorised to see. PR 20 part B /
 * plan #97.
 *
 * Read-only by construction:
 *   - Strict callerPat check (Q2) at run-time entry: undefined
 *     or whitespace-only throws ChatPatRequiredError BEFORE
 *     any LLM call or MCP read.
 *   - PAT-scoped MCP wrapper (Q4-Q5):
 *     `createPatScopedMcpClient(args.mcp, ctx.callerPat!)`
 *     carries the PAT into every read. Production
 *     HttpMcpToolClient injects `Authorization: Bearer <pat>`;
 *     gitea-wiki-mcp-server enforces the user's repo scope.
 *   - Same domainSlug × scopeDomainIds cross-check as
 *     Heartbeat/Lint.
 *
 * No wikiWrite, no MCP write tool. The output is a single
 * JSON payload (answer + citations) returned via the harness;
 * the engine HTTP handler renders it in the response body.
 */
import { spotlight } from "@opencoo/shared/spotlight";
import { loadPromptForScope } from "@opencoo/shared/prompts";
import type { DomainId } from "@opencoo/shared/db";

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { AgentRunContext } from "../../agent-harness/index.js";
import {
  createPatScopedMcpClient,
  type McpToolClient,
} from "../../mcp-tool-client/index.js";
import { assertDomainSlugInScope } from "../scope-check.js";
import { indexSearch, worldviewRead } from "../tools/index.js";

import { ChatPatRequiredError } from "./errors.js";
import { CHAT_OUTPUT_SCHEMA, type ChatOutput } from "./types.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Trim leading + trailing whitespace from a callerPat. Pure
 * function exposed for unit-testing the contract; the body
 * applies it AFTER the strict empty check so the wrapper
 * carries the cleaned token while the harness's verbatim
 * propagation of `ctx.callerPat` is preserved.
 *
 * Copilot #23 fix 4. Production `Authorization: Bearer <pat>`
 * header injection (PR 23+ HttpMcpToolClient) uses the
 * trimmed value; gitea-mcp rejects whitespace-padded tokens.
 */
export function normalizeCallerPat(pat: string): string {
  return pat.trim();
}

export interface RunChatArgs {
  readonly db: Db;
  /** Base McpToolClient — the body wraps this with
   *  `createPatScopedMcpClient(base, ctx.callerPat)` so the
   *  caller never wires the PAT-scoped wrapper directly. */
  readonly mcp: McpToolClient;
  readonly domainSlug: string;
  /** The user's question. Spotlighted before reaching the
   *  prompt — never trusted as instructions. */
  readonly question: string;
  readonly now?: () => Date;
}

export async function runChat(
  ctx: AgentRunContext,
  args: RunChatArgs,
): Promise<ChatOutput> {
  // Q2: strict callerPat check at run-time entry. `undefined`
  // OR whitespace-only fails closed.
  //
  // Copilot #23 fix 4: a whitespace-padded PAT
  // (`"  realtoken  "`) passes the strict empty check but
  // would fail Bearer auth at gitea-mcp if propagated
  // unchanged. Normalize via `normalizeCallerPat` AFTER the
  // empty check so the wrapper carries the cleaned token.
  // The harness's verbatim contract (ctx.callerPat reaches
  // the body unchanged) is preserved — Chat normalizes
  // locally for its own downstream use, not at the harness
  // layer.
  const rawPat = ctx.callerPat;
  if (rawPat === undefined || rawPat.trim().length === 0) {
    throw new ChatPatRequiredError();
  }
  const pat = normalizeCallerPat(rawPat);

  const now = args.now ?? ((): Date => new Date());
  const scope = ctx.instance.scopeDomainIds;
  if (scope.length === 0) {
    throw new Error(
      `chat: instance ${ctx.instance.id} has empty scopeDomainIds — nothing to ground the answer in`,
    );
  }

  // Cross-check: domainSlug must resolve to an id in scope
  // BEFORE any LLM call or MCP read. Same contract as
  // Heartbeat/Lint.
  const resolvedDomainId = await assertDomainSlugInScope({
    db: args.db,
    domainSlug: args.domainSlug,
    scopeDomainIds: scope,
  });
  const domainId = resolvedDomainId as DomainId;

  // Q4-Q5: wrap the base client with the per-call PAT seam.
  // Production HttpMcpToolClient ignores the audit log and
  // uses wrapper.callerPat to inject Authorization headers.
  const scopedMcp = createPatScopedMcpClient(args.mcp, pat);

  // Tool 1: read the per-domain worldview synthesis.
  const worldviewBody = await ctx.callTool("worldview.read", () =>
    worldviewRead(scopedMcp, { domainSlug: args.domainSlug }),
  );

  // Tool 2: enumerate the page index. The LLM picks which
  // pages to cite; v0.1 doesn't fan out to read individual
  // pages from inside the agent — that lands when a Chat
  // multi-turn flow needs it (PR 21+).
  const pagePaths = await ctx.callTool("index.search", () =>
    indexSearch(scopedMcp, { domainSlug: args.domainSlug }),
  );

  const prompt = await loadPromptForScope({
    name: "chat",
    locale: ctx.instance.locale,
    domainId: resolvedDomainId,
    instanceId: ctx.instance.id,
    db: args.db,
  });

  // Spotlight every untrusted source: the user's question,
  // the worldview body, the index. Each in its own
  // <source_content> envelope (defense against memory + user
  // poisoning per THREAT-MODEL §3.5 and Q11).
  const fetchedAt = now();
  const questionEnvelope = spotlight({
    content: args.question,
    source: `chat:user-question`,
    fetchedAt,
  });
  const worldviewEnvelope = spotlight({
    content: worldviewBody,
    source: `worldview://${args.domainSlug}`,
    fetchedAt,
  });
  const indexEnvelope = spotlight({
    content: pagePaths.join("\n"),
    source: `index://${args.domainSlug}`,
    fetchedAt,
  });

  const fullPrompt = `${prompt.body}\n\n# User question\n${questionEnvelope}\n\n# Domain worldview\n${worldviewEnvelope}\n\n# Available wiki pages\n${indexEnvelope}`;

  const result = await ctx.router.generateObject({
    domainId,
    tier: "worker",
    pipelineOrAgent: "chat",
    prompt: fullPrompt,
    schema: CHAT_OUTPUT_SCHEMA,
  });

  return result.object;
}
