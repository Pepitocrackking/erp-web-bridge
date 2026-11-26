import { createHash } from "node:crypto";

/**
 * `sync_hash` de un producto, igual que el del agente Go (packages/erp-agent/internal/delta):
 * SHA-256 en hex de `sku \x1f precio \x1f stock \x1f nombre`, con sku y nombre recortados y precio
 * y stock con exactamente 2 decimales (redondeo de la mitad hacia arriba). Es un contrato estable:
 * solo se usa en el servidor (necesita node:crypto) y sus pruebas comparten los vectores del agente.
 */
export function productSyncHash(p: {
  sku: string;
  name: string;
  price_usd: number;
  stock: number;
}): string {
  const dec2 = (v: number) =>
    ((Math.round(Math.abs(v) * 100) / 100) * Math.sign(v || 1)).toFixed(2);
  const canonical = [p.sku.trim(), dec2(p.price_usd), dec2(p.stock), p.name.trim()].join("\x1f");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
