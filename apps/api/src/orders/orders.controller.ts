import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  confirmOrderInputSchema,
  createOrderInputSchema,
  pendingOrdersQuerySchema,
  type ConfirmOrderInput,
  type ConfirmOrderResult,
  type CreateOrderInput,
  type PendingOrders,
  type PendingOrdersQuery,
  type WebOrder,
} from "@erp-web-bridge/shared-types";
import {
  Agent,
  ApiKeyGuard,
  CurrentUser,
  JwtGuard,
  type AgentContext,
  type UserContext,
} from "../auth/auth.guards";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { OrdersService } from "./orders.service";

/** Lado del comprador: crea pedidos con su JWT. */
@Controller("v1/orgs/:orgId/orders")
@UseGuards(JwtGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(
    @Param("orgId", new ParseUUIDPipe()) orgId: string,
    @CurrentUser() user: UserContext,
    @Body(new ZodValidationPipe(createOrderInputSchema)) body: CreateOrderInput,
  ): Promise<WebOrder> {
    return this.orders.create(orgId, user.userId, body);
  }
}

/** Lado del agente: recoge los pedidos pendientes y confirma los que ya creó en el ERP. */
@Controller("v1/orders")
@UseGuards(ApiKeyGuard)
export class AgentOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get("pending")
  async pending(
    @Agent() agent: AgentContext,
    @Query(new ZodValidationPipe(pendingOrdersQuerySchema)) query: PendingOrdersQuery,
  ): Promise<PendingOrders> {
    return { orders: await this.orders.listPending(agent.orgId, query.limit) };
  }

  @Post(":orderId/confirm")
  @HttpCode(200)
  confirm(
    @Agent() agent: AgentContext,
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body(new ZodValidationPipe(confirmOrderInputSchema)) body: ConfirmOrderInput,
  ): Promise<ConfirmOrderResult> {
    return this.orders.confirm(agent.orgId, orderId, body.erp_order_reference);
  }
}
