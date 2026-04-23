import { z } from "zod";

export const outputChannelRefSchema = z.object({
  adapter_slug: z.string(),
  config: z.record(z.string(), z.unknown()),
});

export const outputChannelRefsSchema = z.array(outputChannelRefSchema);

export type OutputChannelRef = z.infer<typeof outputChannelRefSchema>;
