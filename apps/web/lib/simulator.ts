import { isDemoMode } from "./demo";

/**
 * Simulador de ERP (tarea 6.6): una tabla de inventario "local" (como la de Saint u Odoo) que se
 * edita y se sincroniza de verdad con la API de ingesta, igual que lo haría el agente.
 */
export interface SimRow {
  sku: string;
  name: string;
  category: string | null;
  priceUsd: number;
  stock: number;
  active: boolean;
}

/** Tope de registros por envío del simulador (el límite real del contrato es 1000 por lote). */
export const SIMULATOR_MAX_CHANGES = 200;
const MAX_AMOUNT = 1e9;

/** Importe con 2 decimales, como viaja (y como se guarda: NUMERIC(12,2)). */
const round2 = (v: number) => Math.round(v * 100) / 100;

/** La fila tal como viajaría a la nube: textos recortados e importes a 2 decimales. */
function normalized(r: SimRow) {
  return {
    sku: r.sku.trim(),
    name: r.name.trim(),
    category: r.category?.trim() ? r.category.trim() : null,
    priceUsd: round2(r.priceUsd),
    stock: round2(r.stock),
    active: r.active,
  };
}

/**
 * Filas que hay que enviar: las nuevas y las que difieren de la copia ya sincronizada. Es el
 * diff por contenido del agente (envía solo lo modificado); devolver un valor al original quita el cambio.
 */
export function changedRows(baseline: SimRow[], current: SimRow[]): SimRow[] {
  const before = new Map(baseline.map((r) => [r.sku.trim(), JSON.stringify(normalized(r))]));
  return current.filter((r) => before.get(r.sku.trim()) !== JSON.stringify(normalized(r)));
}

/** Motivos por los que una fila no se puede enviar (lista vacía = válida). */
export function rowErrors(r: SimRow): string[] {
  const errors: string[] = [];
  if (!r.sku.trim()) errors.push("Falta el código.");
  if (!r.name.trim()) errors.push("Falta el nombre.");
  if (!Number.isFinite(r.priceUsd) || r.priceUsd < 0) errors.push("El precio debe ser 0 o más.");
  else if (r.priceUsd > MAX_AMOUNT) errors.push("El precio es demasiado grande.");
  if (!Number.isFinite(r.stock) || r.stock < 0) errors.push("La existencia debe ser 0 o más.");
  else if (r.stock > MAX_AMOUNT) errors.push("La existencia es demasiado grande.");
  return errors;
}

/**
 * Configuración del simulador (solo servidor). Necesita una clave de agente de la organización de
 * demostración: `SIMULATOR_API_KEY`, o la clave de desarrollo del seed si hay modo demo.
 * `orgSlug` es la única organización cuyos administradores pueden usarla, para que la clave de una
 * empresa no se use desde el panel de otra.
 */
export function simulatorConfig(
  env: Record<string, string | undefined> = process.env,
): { apiKey: string; orgSlug: string } | null {
  const apiKey = env.SIMULATOR_API_KEY || (isDemoMode(env) ? "erp_dev_demo_saint_key" : "");
  if (!apiKey) return null;
  return { apiKey, orgSlug: env.SIMULATOR_ORG_SLUG || "demo-saint" };
}
