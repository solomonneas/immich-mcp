import { z } from "zod";

export const Uuid = z.string().uuid();
export const BulkIds = z.array(Uuid).min(1).max(500);
export const Pagination = z.object({
  page: z.number().int().min(1).optional(),
  size: z.number().int().min(1).max(1000).optional(),
});
