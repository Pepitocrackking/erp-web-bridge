import { lineTotalUsd, sumUsd, usdToBs } from "@erp-web-bridge/shared-types";
import type { CartItem } from "./cart";
import { toCatalogItem, type ProductRow } from "./catalog";

export interface CreditInfo {
  limitUsd: number;
  debtUsd: number;
  /** Pedidos web que aún no son deuda en el ERP (pendientes de enviar o enviados). */
  pendingUsd: number;
  availableUsd: number;
}

export interface QuoteLine {
  sku: string;
  name: string;
  quantity: number;
  unitUsd: number;
  unitBs: number;
  lineUsd: number;
  lineBs: number;
  /** Aviso (no bloqueante) si se pide más de lo que hay en existencia. */
  stockWarning: string | null;
}

export interface Quote {
  lines: QuoteLine[];
  /** SKU del carrito que ya no existen o están inactivos: el pedido no puede enviarse con ellos. */
  unavailableSkus: string[];
  totalUsd: number;
  totalBs: number;
  rateBs: number;
  credit: CreditInfo;
  exceedsCredit: boolean;
  /** Cuánto se pasa del crédito disponible (0 si no se pasa). */
  overByUsd: number;
}

/** Crédito disponible = límite - deuda - pedidos pendientes, nunca negativo. Todo en centavos. */
export function creditInfo(limitUsd: number, debtUsd: number, pendingUsd: number): CreditInfo {
  const availableCents =
    Math.round(limitUsd * 100) - Math.round(debtUsd * 100) - Math.round(pendingUsd * 100);
  return { limitUsd, debtUsd, pendingUsd, availableUsd: Math.max(availableCents, 0) / 100 };
}

/**
 * Cotización de un carrito con precios de la lista del comprador. Es informativa: el servidor
 * (API) vuelve a calcular precios y crédito al crear el pedido y es quien decide.
 * El crédito se pasa cuando total > disponible, igual que la API (deuda + pendientes + total <= límite).
 */
export function buildQuote(input: {
  items: CartItem[];
  rows: ProductRow[];
  rateBs: number;
  credit: CreditInfo;
}): Quote {
  const bySku = new Map(input.rows.map((r) => [r.erp_sku, r]));
  const lines: QuoteLine[] = [];
  const unavailableSkus: string[] = [];

  for (const item of input.items) {
    const row = bySku.get(item.sku);
    if (!row) {
      unavailableSkus.push(item.sku);
      continue;
    }
    const product = toCatalogItem(row, "customer", input.rateBs);
    const lineUsd = lineTotalUsd(product.priceUsd, item.quantity);
    const stock = Number(row.stock);
    lines.push({
      sku: item.sku,
      name: product.name,
      quantity: item.quantity,
      unitUsd: product.priceUsd,
      unitBs: product.priceBs,
      lineUsd,
      lineBs: usdToBs(lineUsd, input.rateBs),
      stockWarning:
        item.quantity > stock
          ? stock <= 0
            ? "Agotado"
            : `Solo hay ${String(stock).replace(".", ",")} en existencia`
          : null,
    });
  }

  const totalUsd = sumUsd(lines.map((l) => l.lineUsd));
  const overCents = Math.round(totalUsd * 100) - Math.round(input.credit.availableUsd * 100);
  return {
    lines,
    unavailableSkus,
    totalUsd,
    totalBs: usdToBs(totalUsd, input.rateBs),
    rateBs: input.rateBs,
    credit: input.credit,
    exceedsCredit: overCents > 0,
    overByUsd: Math.max(overCents, 0) / 100,
  };
}
