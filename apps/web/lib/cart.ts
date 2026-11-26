import { ORDER_MAX_LINES, ORDER_MAX_QUANTITY } from "@erp-web-bridge/shared-types";

/**
 * El carrito vive en el navegador (localStorage) y solo guarda SKU y cantidad. Los precios, la
 * existencia y el crédito se piden al servidor cada vez, así nunca se muestra un precio viejo y
 * el servidor sigue siendo quien fija el total del pedido.
 */
export interface CartItem {
  sku: string;
  quantity: number;
}

export const cartKey = (userId: string) => `erpwb.cart.v1.${userId}`;

const SKU_MAX_LENGTH = 64;

function clampQuantity(quantity: number): number {
  return Math.min(Math.max(Math.trunc(quantity), 1), ORDER_MAX_QUANTITY);
}

/** Lee el carrito guardado. Tolerante: un valor corrupto o manipulado da un carrito vacío o limpio. */
export function parseCart(raw: string | null | undefined): CartItem[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const items: CartItem[] = [];
  for (const entry of data) {
    if (items.length >= ORDER_MAX_LINES) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { sku, quantity } = entry as Record<string, unknown>;
    if (typeof sku !== "string" || sku.trim() === "" || sku.length > SKU_MAX_LENGTH) continue;
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 1) continue;
    if (seen.has(sku)) continue;
    seen.add(sku);
    items.push({ sku, quantity: clampQuantity(quantity) });
  }
  return items;
}

export function serializeCart(items: CartItem[]): string {
  return JSON.stringify(items);
}

/** Suma `quantity` a la línea del SKU (o la crea). Respeta los máximos del pedido. */
export function addItem(items: CartItem[], sku: string, quantity: number): CartItem[] {
  if (!Number.isFinite(quantity) || quantity < 1) return items;
  const existing = items.find((i) => i.sku === sku);
  if (existing) {
    return items.map((i) =>
      i.sku === sku ? { sku, quantity: clampQuantity(i.quantity + quantity) } : i,
    );
  }
  if (items.length >= ORDER_MAX_LINES) return items;
  return [...items, { sku, quantity: clampQuantity(quantity) }];
}

/** Fija la cantidad de una línea; 0 o menos la quita. */
export function setQuantity(items: CartItem[], sku: string, quantity: number): CartItem[] {
  if (!Number.isFinite(quantity) || quantity < 1) return removeItem(items, sku);
  return items.map((i) => (i.sku === sku ? { sku, quantity: clampQuantity(quantity) } : i));
}

export function removeItem(items: CartItem[], sku: string): CartItem[] {
  return items.filter((i) => i.sku !== sku);
}
