/**
 * Shared Zod schemas + enums reused across tool inputs.
 * Keep this file small — only truly shared shapes belong here.
 */
import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";

/** Response format toggle — every tool returns either human-readable markdown
 * or machine-friendly JSON. Matches MCP best-practices guidance. */
export const RESPONSE_FORMATS = ["markdown", "json"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];
export const ResponseFormat = {
  MARKDOWN: "markdown" as const,
  JSON: "json" as const,
};

/**
 * NOTE: intentionally NOT using `.default()` — the MCP SDK 1.28's type for
 * `inputSchema` doesn't play well with `ZodDefault`. Defaults are applied in
 * each tool handler via `?? "markdown"` on the optional field.
 */
export const ResponseFormatSchema = z
  .enum(RESPONSE_FORMATS)
  .optional()
  .describe(
    "Output format. 'markdown' is human-readable and compact (default if omitted). 'json' returns full structured data for programmatic use.",
  );

/** Resolve the final format, applying the markdown default. */
export function resolveFormat(f?: ResponseFormat): ResponseFormat {
  return f ?? "markdown";
}

/** Optional repo slug — omit to use the configured default repo.
 * Validation against the repo registry happens inside each tool at runtime
 * (the schema only enforces shape, not membership). */
export const RepoSlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Slug must be lowercase alphanumeric with - or _")
  .optional()
  .describe(
    "Optional repo slug. Omit to use the default repo. Must match a slug in the server's REPOS config.",
  );

/** Pagination fields — same note as ResponseFormatSchema about `.default()`. */
export const PaginationSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Max results to return. 1–${MAX_LIMIT}, default ${DEFAULT_LIMIT} if omitted.`),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of results to skip for pagination. Default 0."),
};

export function resolveLimit(v?: number): number {
  return typeof v === "number" ? v : DEFAULT_LIMIT;
}

export function resolveOffset(v?: number): number {
  return typeof v === "number" ? v : 0;
}

/** Shape of the pagination metadata every list-returning tool echoes back. */
export interface PaginationMeta {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
}

export function buildPaginationMeta(
  total: number,
  count: number,
  offset: number,
): PaginationMeta {
  const has_more = total > offset + count;
  const meta: PaginationMeta = { total, count, offset, has_more };
  if (has_more) meta.next_offset = offset + count;
  return meta;
}
