import type { SupabaseClient } from "@supabase/supabase-js";
import type { CartItem } from "./cart";
import type { Membership, ProductRow } from "./catalog";
import { buildQuote, creditInfo, type CreditInfo, type Quote } from "./quote";

/** Estados de pedido que consumen crédito: igual que la API (todavía no son deuda en el ERP). */
const CREDIT_CONSUMING_STATUSES = ["pending_sync", "synced_to_erp"];

/** Crédito del comprador, leído con su propio JWT: RLS solo le deja ver su cliente y sus pedidos. */
export async function fetchCredit(
  supabase: SupabaseClient,
  customerId: string,
): Promise<CreditInfo> {
  const { data: customer, error } = await supabase
    .from("b2b_customers")
    .select("credit_limit_usd, current_debt_usd")
    .eq("id", customerId)
    .single();
  if (error) throw new Error(`No se pudo leer tu crédito: ${error.message}`);

  const { data: orders, error: ordersError } = await supabase
    .from("web_orders")
    .select("total_usd")
    .eq("customer_id", customerId)
    .in("status", CREDIT_CONSUMING_STATUSES);
  if (ordersError) throw new Error(`No se pudieron leer tus pedidos: ${ordersError.message}`);

  const pendingCents = (orders ?? []).reduce(
    (sum, o) => sum + Math.round(Number(o.total_usd) * 100),
    0,
  );
  return creditInfo(
    Number(customer.credit_limit_usd),
    Number(customer.current_debt_usd),
    pendingCents / 100,
  );
}

/** Cotiza un carrito con precios, existencias y crédito actuales. Solo para compradores. */
export async function fetchQuote(
  supabase: SupabaseClient,
  membership: Membership & { customerId: string },
  items: CartItem[],
): Promise<Quote> {
  const skus = items.map((i) => i.sku);
  let rows: ProductRow[] = [];
  if (skus.length > 0) {
    const { data, error } = await supabase
      .from("products")
      .select(
        "id, erp_sku, name, description, category, image_urls, price_usd, stock, product_prices(price_usd)",
      )
      .eq("org_id", membership.orgId)
      .eq("is_active", true)
      .in("erp_sku", skus);
    if (error) throw new Error(`No se pudo leer el carrito: ${error.message}`);
    rows = (data ?? []) as unknown as ProductRow[];
  }
  const credit = await fetchCredit(supabase, membership.customerId);
  return buildQuote({ items, rows, rateBs: membership.rateBs, credit });
}
