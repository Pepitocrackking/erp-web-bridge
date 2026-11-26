"use server";

import { createOrderInputSchema, usdToBs, webOrderSchema } from "@erp-web-bridge/shared-types";
import type { CartItem } from "../../lib/cart";
import { apiUrl } from "../../lib/api-url";
import { fetchMembership } from "../../lib/catalog";
import { mapOrderError, type OrderFailure } from "../../lib/orders";
import type { Quote } from "../../lib/quote";
import { fetchQuote } from "../../lib/quote-server";
import { createClient } from "../../lib/supabase/server";

/** Usuario y membresía de comprador, o null si no hay sesión o no es un comprador. */
async function buyerContext() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const membership = await fetchMembership(supabase, user.id);
  if (!membership || membership.role !== "customer" || !membership.customerId) return null;
  return { supabase, membership: { ...membership, customerId: membership.customerId } };
}

export type QuoteResult = { ok: true; quote: Quote } | { ok: false; message: string };

export async function quoteCart(items: CartItem[]): Promise<QuoteResult> {
  const parsed = createOrderInputSchema.safeParse({ items });
  if (!parsed.success && items.length > 0) {
    return { ok: false, message: "El carrito no es válido." };
  }
  const ctx = await buyerContext();
  if (!ctx)
    return { ok: false, message: "Entra con una cuenta de comprador para usar el carrito." };
  try {
    return { ok: true, quote: await fetchQuote(ctx.supabase, ctx.membership, items) };
  } catch {
    return { ok: false, message: "No se pudo calcular el carrito. Inténtalo de nuevo." };
  }
}

export interface PlacedOrder {
  id: string;
  totalUsd: number;
  totalBs: number;
  rateBs: number;
  status: string;
}

export type PlaceOrderResult =
  { ok: true; order: PlacedOrder } | { ok: false; failure: OrderFailure };

/**
 * Crea el pedido en la API con el JWT del comprador. La API es la que valida: aquí solo se envían
 * SKU y cantidad (nunca precios ni totales) y se traduce la respuesta.
 */
export async function placeOrder(items: CartItem[], notes: string): Promise<PlaceOrderResult> {
  const input = createOrderInputSchema.safeParse({
    items,
    ...(notes.trim() ? { notes: notes.trim() } : {}),
  });
  if (!input.success) return { ok: false, failure: mapOrderError(400, null) };

  const ctx = await buyerContext();
  if (!ctx) return { ok: false, failure: mapOrderError(403, null) };
  const {
    data: { session },
  } = await ctx.supabase.auth.getSession();
  if (!session) return { ok: false, failure: mapOrderError(401, null) };

  let response: Response;
  try {
    response = await fetch(`${apiUrl()}/v1/orgs/${ctx.membership.orgId}/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(input.data),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return {
      ok: false,
      failure: {
        code: "unexpected",
        message: "No se pudo contactar al servidor. Inténtalo de nuevo.",
      },
    };
  }

  const body: unknown = await response.json().catch(() => null);
  if (response.status !== 201) {
    return { ok: false, failure: mapOrderError(response.status, body) };
  }
  const order = webOrderSchema.safeParse(body);
  if (!order.success) return { ok: false, failure: mapOrderError(500, null) };
  return {
    ok: true,
    order: {
      id: order.data.id,
      totalUsd: order.data.total_usd,
      totalBs: usdToBs(order.data.total_usd, order.data.exchange_rate_used),
      rateBs: order.data.exchange_rate_used,
      status: order.data.status,
    },
  };
}
