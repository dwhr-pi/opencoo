import { z } from "zod";

export const instanceMemorySchema = z.object({
  type: z.enum(["none", "log-tail", "run-history"]),
  count: z.number().int().positive().optional(),
  agent_filter: z.string().optional(),
  format: z.string().optional(),
});

export type InstanceMemory = z.infer<typeof instanceMemorySchema>;
