import { z } from "zod";

/** Contrato mínimo de humo; los DTO reales llegan en la tarea 2.3. */
export const healthSchema = z.object({
  status: z.literal("ok"),
});

export type Health = z.infer<typeof healthSchema>;
