import { usdToBs } from "@erp-web-bridge/shared-types";
import type { SupabaseClient } from "@supabase/supabase-js";

export const CATALOG_PAGE_SIZE = 24;
const SEARCH_MAX_LENGTH = 80;
/** Por encima de esto una "página" es un error o un abuso: se trata como la primera. */
const PAGE_MAX = 100_000;
/** A partir de cuántas unidades se avisa "Quedan N". */
const LOW_STOCK_THRESHOLD = 10;

export type OrgRole = "owner" | "admin" | "staff" | "customer";

export interface CatalogParams {
  q: string;
  category: string;
  page: number;
}

type RawParam = string | string[] | undefined;

function first(value: RawParam): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Normaliza los `searchParams` de la URL: nunca lanza, lo inválido vuelve al valor por defecto. */
export function parseCatalogParams(raw: {
  q?: RawParam;
  category?: RawParam;
  page?: RawParam;
}): CatalogParams {
  const clean = (v: RawParam) => first(v).replace(/\s+/g, " ").trim();
  const pageText = first(raw.page).trim();
  const page = /^\d+$/.test(pageText) ? Number(pageText) : 1;
  return {
    q: clean(raw.q).slice(0, SEARCH_MAX_LENGTH).trim(),
    category: clean(raw.category),
    page: page >= 1 && page <= PAGE_MAX ? page : 1,
  };
}

/**
 * Filtro `or` de PostgREST para buscar por nombre o SKU. El texto del usuario se mezcla en una
 * sintaxis con caracteres especiales (`,` separa condiciones, `()` agrupa, `"` y `\` escapan) y
 * `%`/`_` son comodines de LIKE, así que se eliminan en vez de intentar escaparlos.
 */
export function searchFilter(q: string): string | null {
  const term = q
    .replace(/[,()"\\%_*:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!term) return null;
  return `name.ilike.*${term}*,erp_sku.ilike.*${term}*`;
}

/** El comprador paga el precio de su lista (si la tiene); el personal ve el precio base. */
export function unitPriceUsd(
  role: OrgRole,
  basePriceUsd: number,
  listPrices: { price_usd: number }[],
): number {
  if (role === "customer" && listPrices.length > 0) return Number(listPrices[0]!.price_usd);
  return Number(basePriceUsd);
}

export interface StockLabel {
  text: string;
  level: "ok" | "low" | "out";
}

export function stockLabel(stock: number): StockLabel {
  if (stock <= 0) return { text: "Agotado", level: "out" };
  if (stock <= LOW_STOCK_THRESHOLD) {
    return { text: `Quedan ${String(stock).replace(".", ",")}`, level: "low" };
  }
  return { text: "Disponible", level: "ok" };
}

export interface ProductRow {
  id: string;
  erp_sku: string;
  name: string;
  description: string | null;
  category: string | null;
  image_urls: string[];
  price_usd: number;
  stock: number;
  product_prices: { price_usd: number }[];
}

export interface CatalogItem {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  imageUrl: string | null;
  priceUsd: number;
  priceBs: number;
  stock: StockLabel;
}

export function toCatalogItem(row: ProductRow, role: OrgRole, rateBs: number): CatalogItem {
  const priceUsd = unitPriceUsd(role, row.price_usd, row.product_prices ?? []);
  return {
    id: row.id,
    sku: row.erp_sku,
    name: row.name,
    description: row.description,
    category: row.category,
    imageUrl: row.image_urls?.[0] ?? null,
    priceUsd,
    priceBs: usdToBs(priceUsd, rateBs),
    stock: stockLabel(Number(row.stock)),
  };
}

export interface Membership {
  orgId: string;
  orgName: string;
  role: OrgRole;
  rateBs: number;
}

/**
 * Organización del usuario. Un usuario puede pertenecer a varias; por ahora se usa la primera
 * (la más antigua). RLS solo deja ver membresías propias a quien no es administrador, y los
 * administradores ven las de toda su organización: por eso se filtra por `user_id`.
 */
export async function fetchMembership(
  supabase: SupabaseClient,
  userId: string,
): Promise<Membership | null> {
  const { data: member, error } = await supabase
    .from("org_members")
    .select("org_id, role")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`No se pudo leer la membresía: ${error.message}`);
  if (!member) return null;

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, name, exchange_rate_bs")
    .eq("id", member.org_id)
    .single();
  if (orgError) throw new Error(`No se pudo leer la organización: ${orgError.message}`);
  return {
    orgId: org.id,
    orgName: org.name,
    role: member.role as OrgRole,
    rateBs: Number(org.exchange_rate_bs),
  };
}

export interface CategoryCount {
  category: string;
  count: number;
}

export async function fetchCategories(
  supabase: SupabaseClient,
  orgId: string,
): Promise<CategoryCount[]> {
  const { data, error } = await supabase
    .from("catalog_categories")
    .select("category, product_count")
    .eq("org_id", orgId)
    .order("category", { ascending: true });
  if (error) throw new Error(`No se pudieron leer las categorías: ${error.message}`);
  return (data ?? []).map((r) => ({ category: r.category, count: r.product_count }));
}

export interface CatalogPage {
  items: CatalogItem[];
  total: number;
  page: number;
  pageCount: number;
}

export async function fetchCatalog(
  supabase: SupabaseClient,
  membership: Membership,
  params: CatalogParams,
): Promise<CatalogPage> {
  const from = (params.page - 1) * CATALOG_PAGE_SIZE;
  let query = supabase
    .from("products")
    .select(
      "id, erp_sku, name, description, category, image_urls, price_usd, stock, product_prices(price_usd)",
      { count: "exact" },
    )
    .eq("org_id", membership.orgId)
    .eq("is_active", true);
  if (params.category) query = query.eq("category", params.category);
  const filter = searchFilter(params.q);
  if (filter) query = query.or(filter);

  const { data, count, error } = await query
    .order("name", { ascending: true })
    .order("erp_sku", { ascending: true })
    .range(from, from + CATALOG_PAGE_SIZE - 1);
  if (error) throw new Error(`No se pudo leer el catálogo: ${error.message}`);

  const total = count ?? 0;
  return {
    items: ((data ?? []) as unknown as ProductRow[]).map((row) =>
      toCatalogItem(row, membership.role, membership.rateBs),
    ),
    total,
    page: params.page,
    pageCount: Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE)),
  };
}
