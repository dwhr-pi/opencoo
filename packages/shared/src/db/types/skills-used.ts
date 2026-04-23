import { z } from "zod";

export const skillsUsedEntrySchema = z.object({
  slug: z.string(),
  version: z.string(),
  sha: z.string(),
  source: z.enum(["marketplace", "overlay", "vendored"]),
});

export const skillsUsedSchema = z.array(skillsUsedEntrySchema);

export type SkillsUsedEntry = z.infer<typeof skillsUsedEntrySchema>;
export type SkillsUsed = z.infer<typeof skillsUsedSchema>;
