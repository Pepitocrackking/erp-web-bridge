import { z } from "zod";

export * from "./contracts";

/** Contrato de humo del endpoint GET /health. */
export const healthSchema = z.object({
  status: z.literal("ok"),
});

export type Health = z.infer<typeof healthSchema>;

export * from "./money";
