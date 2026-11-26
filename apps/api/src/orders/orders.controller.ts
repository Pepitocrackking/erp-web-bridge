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
import { ApiQuery } from "@nestjs/swagger";
import {
  confirmOrderInputSchema,
  confirmOrderResultSchema,
  createOrderInputSchema,
  failOrderInputSchema,
  failOrderResultSchema,
  pendingOrdersSchema,
  retryOrderResultSchema,
  webOrderSchema,
  pendingOrdersQuerySchema,
  type ConfirmOrderInput,
  type ConfirmOrderResult,
  type CreateOrderInput,
  type FailOrderInput,
  type FailOrderResult,
  type RetryOrderResult,
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
import { ApiEndpoint } from "../common/openapi";
import { RateLimit } from "../common/rate-limit";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { OrdersService } from "./orders.service";

/** Lado del comprador: crea pedidos con su JWT. */
@Controller("v1/orgs/:orgId/orders")
@UseGuards(JwtGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @RateLimit("strict")
  @ApiEndpoint({
    tag: "orders",
    summary: "Crear un pedido",
    description:
      "Lo crea un comprador (rol customer) de la organización. El cuerpo solo trae SKU y cantidad; " +
      "precios, total y tasa los fija el servidor. Valida el límite de crédito: deuda del ERP + " +
      "pedidos pendientes o enviados + total nuevo no puede superarlo (422 credit_limit_exceeded).",
    auth: "user",
    body: createOrderInputSchema,
    response: {
      status: 201,
      description: "Pedido creado, pendiente de enviar al ERP",
      schema: webOrderSchema,
    },
    errors: [400, 403, 404, 422],
  })
  create(
    @Param("orgId", new ParseUUIDPipe()) orgId: string,
    @CurrentUser() user: UserContext,
    @Body(new ZodValidationPipe(createOrderInputSchema)) body: CreateOrderInput,
  ): Promise<WebOrder> {
    return this.orders.create(orgId, user.userId, body);
  }

  @Post(":orderId/retry")
  @HttpCode(200)
  @RateLimit("strict")
  @ApiEndpoint({
    tag: "orders",
    summary: "Reintentar un pedido en error",
    description:
      "Lo devuelve a la cola (error → pending_sync) y borra el motivo del fallo; el agente lo recoge " +
      "en su próximo ciclo. Solo el personal (owner, admin o staff). Un pedido que ya estaba pendiente " +
      "devuelve changed=false; en cualquier otro estado, 409. No vuelve a validar el crédito.",
    auth: "user",
    response: {
      status: 200,
      description: "Pedido de nuevo pendiente de enviar al ERP",
      schema: retryOrderResultSchema,
    },
    errors: [400, 403, 404, 409],
  })
  retry(
    @Param("orgId", new ParseUUIDPipe()) orgId: string,
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @CurrentUser() user: UserContext,
  ): Promise<RetryOrderResult> {
    return this.orders.retry(orgId, user.userId, orderId);
  }
}

/** Lado del agente: recoge los pedidos pendientes y confirma los que ya creó en el ERP. */
@Controller("v1/orders")
@UseGuards(ApiKeyGuard)
export class AgentOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get("pending")
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
  })
  @ApiEndpoint({
    tag: "orders",
    summary: "Pedidos pendientes de enviar al ERP",
    description:
      "Los más antiguos primero. No modifica nada: se pueden consultar las veces que haga falta.",
    auth: "agent",
    response: {
      status: 200,
      description: "Pedidos en estado pending_sync",
      schema: pendingOrdersSchema,
    },
    errors: [400],
  })
  async pending(
    @Agent() agent: AgentContext,
    @Query(new ZodValidationPipe(pendingOrdersQuerySchema)) query: PendingOrdersQuery,
  ): Promise<PendingOrders> {
    return { orders: await this.orders.listPending(agent.orgId, query.limit) };
  }

  @Post(":orderId/confirm")
  @HttpCode(200)
  @ApiEndpoint({
    tag: "orders",
    summary: "Confirmar que el borrador ya existe en el ERP",
    description:
      "Idempotente: confirmar otra vez con la misma referencia devuelve duplicate=true sin cambiar " +
      "nada; otra referencia, o un estado que no admite confirmación, da 409.",
    auth: "agent",
    body: confirmOrderInputSchema,
    response: {
      status: 200,
      description: "Pedido confirmado (o ya lo estaba)",
      schema: confirmOrderResultSchema,
    },
    errors: [400, 404, 409],
  })
  confirm(
    @Agent() agent: AgentContext,
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body(new ZodValidationPipe(confirmOrderInputSchema)) body: ConfirmOrderInput,
  ): Promise<ConfirmOrderResult> {
    return this.orders.confirm(agent.orgId, orderId, body.erp_order_reference);
  }

  @Post(":orderId/fail")
  @HttpCode(200)
  @ApiEndpoint({
    tag: "orders",
    summary: "Informar que el ERP no puede aceptar el pedido",
    description:
      "Para fallos permanentes (cliente o producto inexistente o inactivo en el ERP): el pedido pasa a " +
      "error con el motivo, que el panel muestra. Los fallos transitorios no se informan: el agente " +
      "reintenta solo. Idempotente: si ya estaba en error devuelve duplicate=true y conserva el primer " +
      "motivo. En cualquier otro estado, 409.",
    auth: "agent",
    body: failOrderInputSchema,
    response: {
      status: 200,
      description: "Pedido marcado con error (o ya lo estaba)",
      schema: failOrderResultSchema,
    },
    errors: [400, 404, 409],
  })
  fail(
    @Agent() agent: AgentContext,
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
    @Body(new ZodValidationPipe(failOrderInputSchema)) body: FailOrderInput,
  ): Promise<FailOrderResult> {
    return this.orders.fail(agent.orgId, orderId, body.error_detail);
  }
}
