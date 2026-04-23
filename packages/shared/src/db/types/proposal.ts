import { z } from "zod";

export const proposalSchema = z.object({
  title: z.string(),
  summary: z.string(),
  template_slug: z.string(),
  params: z.record(z.string(), z.unknown()),
});

export type Proposal = z.infer<typeof proposalSchema>;
