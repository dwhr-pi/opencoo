import { z } from "zod";

export const toolCallSchema = z.object({
  name: z.string(),
  args: z.unknown(),
  result: z.unknown().optional(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});

export const toolCallsSchema = z.array(toolCallSchema);

export type ToolCall = z.infer<typeof toolCallSchema>;
