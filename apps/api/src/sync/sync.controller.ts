import { Body, Controller, HttpCode, Post, UseGuards, UseInterceptors } from "@nestjs/common";
import {
  customerSyncBatchSchema,
  productSyncBatchSchema,
  type CustomerSyncBatch,
  type ProductSyncBatch,
} from "@erp-web-bridge/shared-types";
import { Agent, ApiKeyGuard, type AgentContext } from "../auth/auth.guards";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CustomersSyncService } from "./customers-sync.service";
import { ProductsSyncService } from "./products-sync.service";
import { SyncEntityName, SyncFailureLogInterceptor } from "./sync-failure-log.interceptor";

@Controller("v1/sync")
@UseGuards(ApiKeyGuard)
@UseInterceptors(SyncFailureLogInterceptor)
export class SyncController {
  constructor(
    private readonly products: ProductsSyncService,
    private readonly customers: CustomersSyncService,
  ) {}

  /** El agente empuja un lote de productos. La organización sale de la x-api-key, no del cuerpo. */
  @Post("products")
  @SyncEntityName("products")
  @HttpCode(200)
  syncProducts(
    @Agent() agent: AgentContext,
    @Body(new ZodValidationPipe(productSyncBatchSchema)) batch: ProductSyncBatch,
  ) {
    return this.products.ingest(agent.orgId, batch);
  }

  /** El agente empuja un lote de clientes con su límite de crédito y su deuda actual. */
  @Post("customers")
  @SyncEntityName("customers")
  @HttpCode(200)
  syncCustomers(
    @Agent() agent: AgentContext,
    @Body(new ZodValidationPipe(customerSyncBatchSchema)) batch: CustomerSyncBatch,
  ) {
    return this.customers.ingest(agent.orgId, batch);
  }
}
