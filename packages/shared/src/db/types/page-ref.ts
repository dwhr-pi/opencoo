import { z } from "zod";

export const pageRefSchema = z.object({
  domain_slug: z.string(),
  page_path: z.string(),
});

export const pageRefsSchema = z.array(pageRefSchema);

export type PageRef = z.infer<typeof pageRefSchema>;
