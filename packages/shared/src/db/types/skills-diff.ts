import { z } from "zod";

export const skillsDiffSchema = z.object({
  added: z.array(z.string()),
  changed: z.array(z.string()),
  removed: z.array(z.string()),
});

export type SkillsDiff = z.infer<typeof skillsDiffSchema>;
