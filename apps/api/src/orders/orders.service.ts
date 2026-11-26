import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  ConfirmOrderResult,
  CreateOrderInput,
  FailOrderResult,
  OrderStatus,
  RetryOrderResult,
  WebOrder,
} from "@erp-web-bridge/shared-types";
import { DatabaseService } from "../database/database.module";
import { findDuplicates } from "../sync/reconciliation";

/** Pedidos que todavía no son deuda en el ERP y por eso consumen crédito: borrador pendiente de enviar o ya enviado. */
const CREDIT_CONSUMING_STATUSES = ["pending_sync", "synced_to_erp"];

interface LineRow {
  sku: string;
  qty: number;
  available: boolean;
  unit_price: string | null;
  line_total: string | null;
}

interface PendingRow {
  id: string;
  customer_code: string;
  status: OrderStatus;
  total_usd: number;
  exchange_rate_used: number;
  items: Array<{ sku: string; quantity: number; unit_price_usd: number }>;
  erp_order_reference: string | null;
  notes: string | null;
  created_at: Date;
}

@Injectable()
export class OrdersService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Crea el pedido de un comprador (rol `customer`) de la organización.
   *
   * Quién es el comprador y a qué cliente pertenece se averigua como el usuario, bajo RLS
   * (`org_members`); de ahí en adelante la transacción corre como `postgres` porque los usuarios no
   * tienen INSERT en `web_orders`. El cliente sale SIEMPRE de la membresía y cada sentencia filtra
   * por `org_id` y `customer_id`: el cuerpo solo trae SKU y cantidad.
   *
   * Precios y total los calcula Postgres en NUMERIC (nada de coma flotante). El crédito se valida
   * dentro de la transacción con un bloqueo asesor por cliente, así dos pedidos simultáneos no
   * pasan los dos por el mismo hueco del límite.
   */
  async create(orgId: string, userId: string, input: CreateOrderInput): Promise<WebOrder> {
    const customerId = await this.customerOf(orgId, userId);

    const skus = input.items.map((i) => i.sku);
    const repeated = findDuplicates(skus);
    if (repeated.length > 0) {
      throw new UnprocessableEntityException({
        message: "SKU repetidos en el pedido",
        skus: repeated.slice(0, 20),
      });
    }

    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `credit:${customerId}`,
      ]);

      const cust = (
        await client.query<{
          erp_customer_code: string;
          price_list_id: string | null;
          customer_active: boolean;
          org_active: boolean;
          rate: string;
        }>(
          `SELECT c.erp_customer_code, c.price_list_id, c.is_active AS customer_active,
                  o.is_active AS org_active, o.exchange_rate_bs::text AS rate
             FROM public.b2b_customers c
             JOIN public.organizations o ON o.id = c.org_id
            WHERE c.id = $1 AND c.org_id = $2`,
          [customerId, orgId],
        )
      ).rows[0];
      if (!cust) throw new NotFoundException("Cliente no encontrado");
      if (!cust.org_active || !cust.customer_active) {
        throw new ForbiddenException("La organización o el cliente están inactivos");
      }

      // Precio de la lista del cliente y, si no hay, el precio base del producto.
      const lines = (
        await client.query<LineRow>(
          `WITH req AS (
             SELECT * FROM unnest($3::text[], $4::int[]) WITH ORDINALITY AS t(sku, qty, ord)
           )
           SELECT r.sku, r.qty,
                  (p.id IS NOT NULL AND p.is_active) AS available,
                  COALESCE(pp.price_usd, p.price_usd)::text AS unit_price,
                  (r.qty * COALESCE(pp.price_usd, p.price_usd))::text AS line_total
             FROM req r
             LEFT JOIN public.products p ON p.org_id = $1 AND p.erp_sku = r.sku
             LEFT JOIN public.product_prices pp
                    ON pp.org_id = $1 AND pp.product_id = p.id AND pp.price_list_id = $2::uuid
            ORDER BY r.ord`,
          [orgId, cust.price_list_id, skus, input.items.map((i) => i.quantity)],
        )
      ).rows;

      const unavailable = lines.filter((l) => !l.available).map((l) => l.sku);
      if (unavailable.length > 0) {
        throw new UnprocessableEntityException({
          message: "Hay productos inexistentes o inactivos en el pedido",
          skus: unavailable.slice(0, 50),
        });
      }

      const total = (
        await client.query<{ total: string }>(
          "SELECT COALESCE(sum(t), 0)::text AS total FROM unnest($1::numeric[]) AS t",
          [lines.map((l) => l.line_total)],
        )
      ).rows[0]!.total;

      const credit = (
        await client.query<{
          ok: boolean;
          credit_limit: string;
          debt: string;
          pending: string;
          available: string;
        }>(
          `SELECT (c.current_debt_usd + pend.pending + $3::numeric <= c.credit_limit_usd) AS ok,
                  c.credit_limit_usd::text AS credit_limit,
                  c.current_debt_usd::text AS debt,
                  pend.pending::text AS pending,
                  GREATEST(c.credit_limit_usd - c.current_debt_usd - pend.pending, 0)::text AS available
             FROM public.b2b_customers c
            CROSS JOIN LATERAL (
              SELECT COALESCE(sum(total_usd), 0) AS pending
                FROM public.web_orders
               WHERE org_id = $1 AND customer_id = $2 AND status = ANY($4::text[])
            ) pend
            WHERE c.id = $2 AND c.org_id = $1`,
          [orgId, customerId, total, CREDIT_CONSUMING_STATUSES],
        )
      ).rows[0]!;

      if (!credit.ok) {
        throw new UnprocessableEntityException({
          code: "credit_limit_exceeded",
          message: "El pedido supera el límite de crédito disponible",
          credit_limit_usd: Number(credit.credit_limit),
          current_debt_usd: Number(credit.debt),
          pending_orders_usd: Number(credit.pending),
          order_total_usd: Number(total),
          available_usd: Number(credit.available),
        });
      }

      const items = lines.map((l) => ({
        sku: l.sku,
        quantity: l.qty,
        unit_price_usd: Number(l.unit_price),
      }));
      const inserted = (
        await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO public.web_orders
             (org_id, customer_id, status, total_usd, exchange_rate_used, items, notes)
           VALUES ($1, $2, 'pending_sync', $3::numeric, $4::numeric, $5::jsonb, $6)
           RETURNING id, created_at`,
          [orgId, customerId, total, cust.rate, JSON.stringify(items), input.notes ?? null],
        )
      ).rows[0]!;
      await client.query("COMMIT");

      return {
        id: inserted.id,
        customer_code: cust.erp_customer_code,
        status: "pending_sync",
        total_usd: Number(total),
        exchange_rate_used: Number(cust.rate),
        items,
        erp_order_reference: null,
        notes: input.notes ?? null,
        created_at: inserted.created_at.toISOString(),
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Cliente del comprador. 404 si no es miembro (no se revela la organización); 403 si no es comprador. */
  private async customerOf(orgId: string, userId: string): Promise<string> {
    const member = await this.db.withUser(userId, async (client) => {
      const res = await client.query<{ role: string; customer_id: string | null }>(
        "SELECT role, customer_id FROM public.org_members WHERE org_id = $1 AND user_id = $2",
        [orgId, userId],
      );
      return res.rows[0];
    });
    if (!member) throw new NotFoundException("Organización no encontrada");
    if (member.role !== "customer" || !member.customer_id) {
      throw new ForbiddenException("Solo un comprador de la organización puede crear pedidos");
    }
    return member.customer_id;
  }

  /** Pedidos por enviar al ERP de una organización, los más antiguos primero. No modifica nada. */
  async listPending(orgId: string, limit: number): Promise<WebOrder[]> {
    const { rows } = await this.db.pool.query<PendingRow>(
      `SELECT w.id, c.erp_customer_code AS customer_code, w.status,
              w.total_usd::float AS total_usd, w.exchange_rate_used::float AS exchange_rate_used,
              w.items, w.erp_order_reference, w.notes, w.created_at
         FROM public.web_orders w
         JOIN public.b2b_customers c ON c.id = w.customer_id AND c.org_id = w.org_id
        WHERE w.org_id = $1 AND w.status = 'pending_sync'
        ORDER BY w.created_at, w.id
        LIMIT $2`,
      [orgId, limit],
    );
    return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
  }

  /**
   * El agente informa que creó el borrador en el ERP. Idempotente:
   *  - pendiente → `synced_to_erp` con la referencia (una sola vez; deja una fila en sync_logs);
   *  - ya confirmado con la MISMA referencia → 200 `duplicate: true`, sin cambiar nada;
   *  - ya confirmado con OTRA referencia, o en un estado que no admite confirmación → 409.
   * `FOR UPDATE` serializa las confirmaciones simultáneas del mismo pedido, y el índice único
   * (org_id, erp_order_reference) impide que dos pedidos compartan referencia.
   */
  async confirm(orgId: string, orderId: string, reference: string): Promise<ConfirmOrderResult> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const order = (
        await client.query<{
          status: OrderStatus;
          erp_order_reference: string | null;
          synced_at: Date | null;
        }>(
          `SELECT status, erp_order_reference, synced_at FROM public.web_orders
            WHERE id = $1 AND org_id = $2 FOR UPDATE`,
          [orderId, orgId],
        )
      ).rows[0];
      if (!order) throw new NotFoundException("Pedido no encontrado");

      if (order.status === "pending_sync") {
        const updated = (
          await client.query<{ status: OrderStatus; synced_at: Date }>(
            `UPDATE public.web_orders
                SET status = 'synced_to_erp', erp_order_reference = $3, synced_at = now()
              WHERE id = $1 AND org_id = $2
              RETURNING status, synced_at`,
            [orderId, orgId, reference],
          )
        ).rows[0]!;
        await client.query(
          `INSERT INTO public.sync_logs (org_id, direction, entity, records_processed, status)
           VALUES ($1, 'cloud_to_erp', 'orders', 1, 'success')`,
          [orgId],
        );
        await client.query("COMMIT");
        return {
          id: orderId,
          status: updated.status,
          erp_order_reference: reference,
          synced_at: updated.synced_at.toISOString(),
          duplicate: false,
        };
      }

      if (order.status === "synced_to_erp" || order.status === "approved") {
        if (order.erp_order_reference !== reference) {
          throw new ConflictException({
            code: "already_confirmed",
            message: "El pedido ya fue confirmado con otra referencia del ERP",
            status: order.status,
            erp_order_reference: order.erp_order_reference,
          });
        }
        await client.query("COMMIT");
        return {
          id: orderId,
          status: order.status,
          erp_order_reference: reference,
          synced_at: (order.synced_at as Date).toISOString(),
          duplicate: true,
        };
      }

      throw new ConflictException({
        code: "order_not_confirmable",
        message: `Un pedido en estado ${order.status} no se puede confirmar`,
        status: order.status,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      // 23505 = índice único (org_id, erp_order_reference): la referencia ya es de otro pedido.
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException({
          code: "erp_reference_in_use",
          message: "Esa referencia del ERP ya pertenece a otro pedido",
        });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * El agente informa que el ERP NO puede aceptar el pedido y que reintentar no lo arregla (cliente
   * o producto inexistente o inactivo en el ERP...). Los fallos transitorios (red, ERP caído) no se
   * informan: el agente reintenta solo y el pedido sigue `pending_sync`.
   *  - pendiente → `error` con el motivo (una sola vez; deja una fila `error` en sync_logs);
   *  - ya en `error` → 200 `duplicate: true`, sin cambiar nada (se conserva el primer motivo);
   *  - cualquier otro estado (ya confirmado, anulado...) → 409.
   * El personal lo devuelve a la cola con `retry`.
   */
  async fail(orgId: string, orderId: string, detail: string): Promise<FailOrderResult> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const order = (
        await client.query<{ status: OrderStatus; error_detail: string | null }>(
          `SELECT status, error_detail FROM public.web_orders
            WHERE id = $1 AND org_id = $2 FOR UPDATE`,
          [orderId, orgId],
        )
      ).rows[0];
      if (!order) throw new NotFoundException("Pedido no encontrado");

      if (order.status === "pending_sync") {
        await client.query(
          `UPDATE public.web_orders SET status = 'error', error_detail = $3
            WHERE id = $1 AND org_id = $2`,
          [orderId, orgId, detail],
        );
        await client.query(
          `INSERT INTO public.sync_logs (org_id, direction, entity, records_processed, status, error_detail)
           VALUES ($1, 'cloud_to_erp', 'orders', 0, 'error', $2)`,
          [orgId, `Pedido ${orderId}: ${detail}`.slice(0, 1500)],
        );
        await client.query("COMMIT");
        return { id: orderId, status: "error", error_detail: detail, duplicate: false };
      }
      if (order.status === "error") {
        await client.query("COMMIT");
        return { id: orderId, status: "error", error_detail: order.error_detail, duplicate: true };
      }
      throw new ConflictException({
        code: "order_not_failable",
        message: `Un pedido en estado ${order.status} no se puede marcar con error`,
        status: order.status,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * El personal (owner, admin o staff) devuelve a la cola un pedido en `error`, p. ej. tras dar de
   * alta en el ERP el cliente que faltaba. Pasa a `pending_sync` y se borra el motivo; el agente lo
   * recoge en su próximo ciclo. Ya pendiente → 200 `changed: false`; cualquier otro estado → 409.
   * No se vuelve a validar el crédito: lo decide el personal que lo reintenta.
   */
  async retry(orgId: string, userId: string, orderId: string): Promise<RetryOrderResult> {
    const member = await this.db.withUser(userId, async (client) => {
      const res = await client.query<{ role: string }>(
        "SELECT role FROM public.org_members WHERE org_id = $1 AND user_id = $2",
        [orgId, userId],
      );
      return res.rows[0];
    });
    if (!member) throw new NotFoundException("Organización no encontrada");
    if (member.role === "customer") {
      throw new ForbiddenException("Solo el personal de la organización puede reintentar pedidos");
    }

    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const order = (
        await client.query<{ status: OrderStatus }>(
          "SELECT status FROM public.web_orders WHERE id = $1 AND org_id = $2 FOR UPDATE",
          [orderId, orgId],
        )
      ).rows[0];
      if (!order) throw new NotFoundException("Pedido no encontrado");

      if (order.status === "error") {
        await client.query(
          `UPDATE public.web_orders SET status = 'pending_sync', error_detail = NULL
            WHERE id = $1 AND org_id = $2`,
          [orderId, orgId],
        );
        await client.query("COMMIT");
        return { id: orderId, status: "pending_sync", changed: true };
      }
      if (order.status === "pending_sync") {
        await client.query("COMMIT");
        return { id: orderId, status: "pending_sync", changed: false };
      }
      throw new ConflictException({
        code: "order_not_retryable",
        message: `Un pedido en estado ${order.status} no se puede reintentar`,
        status: order.status,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
