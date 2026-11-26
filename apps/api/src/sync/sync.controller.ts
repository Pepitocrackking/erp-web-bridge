import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { productSyncBatchSchema, type ProductSyncBatch } from "@erp-web-bridge/shared-types";
import { Agent, ApiKeyGuard, type AgentContext } from "../auth/auth.guards";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ProductsSyncService } from "./products-sync.service";

@Controller("v1/sync")
@UseGuards(ApiKeyGuard)
export class SyncController {
  constructor(private readonly products: ProductsSyncService) {}

  /** El agente empuja un lote de productos. La organización sale de la x-api-key, no del cuerpo. */
  @Post("products")
  @HttpCode(200)
  syncProducts(
    @Agent() agent: AgentContext,
    @Body(new ZodValidationPipe(productSyncBatchSchema)) batch: ProductSyncBatch,
  ) {
    return this.products.ingest(agent.orgId, batch);
  }
}
