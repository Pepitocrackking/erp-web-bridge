import { Body, Controller, HttpCode, Post, UseGuards, UseInterceptors } from "@nestjs/common";
import {
  customerSyncBatchSchema,
  productSyncBatchSchema,
  type CustomerSyncBatch,
  type ProductSyncBatch,
  syncResultSchema,
} from "@erp-web-bridge/shared-types";
import { Agent, ApiKeyGuard, type AgentContext } from "../auth/auth.guards";
import { ApiEndpoint } from "../common/openapi";
import { RateLimit } from "../common/rate-limit";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CustomersSyncService } from "./customers-sync.service";
import { ProductsSyncService } from "./products-sync.service";
import { SyncEntityName, SyncFailureLogInterceptor } from "./sync-failure-log.interceptor";

@Controller("v1/sync")
@UseGuards(ApiKeyGuard)
@UseInterceptors(SyncFailureLogInterceptor)
@RateLimit("sync")
export class SyncController {
  constructor(
    private readonly products: ProductsSyncService,
    private readonly customers: CustomersSyncService,
  ) {}

  /** El agente empuja un lote de productos. La organización sale de la x-api-key, no del cuerpo. */
  @Post("products")
  @ApiEndpoint({
    tag: "sync",
    summary: "Sincronizar un lote de productos",
    description:
      "Upsert masivo por (organización, SKU) de hasta 1000 productos. Idempotente por batch_id. " +
      "Una reconciliación completa viaja en varios lotes con el mismo reconciliation_id; solo el " +
      "último (final_batch) desactiva lo que el ERP ya no envía, y solo si total_records cuadra.",
    auth: "agent",
    body: productSyncBatchSchema,
    response: {
      status: 200,
      description: "Lote procesado (o reconocido como reenvío)",
      schema: syncResultSchema,
    },
    errors: [400, 409, 413, 422],
  })
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
  @ApiEndpoint({
    tag: "sync",
    summary: "Sincronizar un lote de clientes",
    description:
      "Upsert masivo por (organización, código de cliente) con límite de crédito y deuda. " +
      "Misma mecánica de idempotencia y reconciliación que los productos.",
    auth: "agent",
    body: customerSyncBatchSchema,
    response: {
      status: 200,
      description: "Lote procesado (o reconocido como reenvío)",
      schema: syncResultSchema,
    },
    errors: [400, 409, 413, 422],
  })
  @SyncEntityName("customers")
  @HttpCode(200)
  syncCustomers(
    @Agent() agent: AgentContext,
    @Body(new ZodValidationPipe(customerSyncBatchSchema)) batch: CustomerSyncBatch,
  ) {
    return this.customers.ingest(agent.orgId, batch);
  }
}
