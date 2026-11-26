/** Traduce la respuesta de POST /v1/orgs/:orgId/orders a algo que la pantalla sabe mostrar. */

export interface CreditDetail {
  limitUsd: number;
  debtUsd: number;
  pendingUsd: number;
  orderTotalUsd: number;
  availableUsd: number;
}

export type OrderFailure =
  | { code: "credit_limit_exceeded"; message: string; credit: CreditDetail }
  | { code: "unavailable_products"; message: string; skus: string[] }
  | { code: "repeated_products"; message: string; skus: string[] }
  | {
      code: "rate_limited" | "unauthorized" | "forbidden" | "invalid" | "unexpected";
      message: string;
    };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

export function mapOrderError(status: number, body: unknown): OrderFailure {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  switch (status) {
    case 401:
      return { code: "unauthorized", message: "Tu sesión expiró. Entra de nuevo." };
    case 403:
      return { code: "forbidden", message: "Tu cuenta no puede hacer pedidos en esta empresa." };
    case 429:
      return {
        code: "rate_limited",
        message: "Estás enviando pedidos muy rápido. Espera un minuto e inténtalo de nuevo.",
      };
    case 400:
      return { code: "invalid", message: "El pedido no es válido. Revisa las cantidades." };
    case 422:
      if (b.code === "credit_limit_exceeded") {
        return {
          code: "credit_limit_exceeded",
          message: "El pedido supera tu límite de crédito disponible.",
          credit: {
            limitUsd: num(b.credit_limit_usd),
            debtUsd: num(b.current_debt_usd),
            pendingUsd: num(b.pending_orders_usd),
            orderTotalUsd: num(b.order_total_usd),
            availableUsd: num(b.available_usd),
          },
        };
      }
      if (typeof b.message === "string" && b.message.startsWith("SKU repetidos")) {
        return {
          code: "repeated_products",
          message: "Hay productos repetidos en el pedido.",
          skus: strings(b.skus),
        };
      }
      if (typeof b.message === "string" && b.message.includes("inexistentes o inactivos")) {
        return {
          code: "unavailable_products",
          message: "Algunos productos ya no están disponibles. Quítalos del carrito.",
          skus: strings(b.skus),
        };
      }
      return { code: "unexpected", message: "No se pudo crear el pedido. Inténtalo de nuevo." };
    default:
      return { code: "unexpected", message: "No se pudo crear el pedido. Inténtalo de nuevo." };
  }
}
