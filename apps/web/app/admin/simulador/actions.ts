"use server";

import { randomUUID } from "node:crypto";
import { apiUrl } from "../../../lib/api-url";
import { fetchMembership } from "../../../lib/catalog";
import {
  rowErrors,
  SIMULATOR_MAX_CHANGES,
  simulatorConfig,
  type SimRow,
} from "../../../lib/simulator";
import { productSyncHash } from "../../../lib/sync-hash";
import { createClient } from "../../../lib/supabase/server";

export interface SyncOutcome {
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
}

export type SimulatorResult = { ok: true; outcome: SyncOutcome } | { ok: false; message: string };

/**
 * Envía los cambios del simulador a `POST /v1/sync/products` con la clave de agente de la
 * organización de demostración. La clave vive solo en el servidor; aquí se comprueba que quien
 * pide el envío es administrador de esa organización y se calcula el `sync_hash` igual que el agente.
 */
export async function syncSimulatedInventory(rows: SimRow[]): Promise<SimulatorResult> {
  const config = simulatorConfig();
  if (!config) return { ok: false, message: "El simulador no está activado en este servidor." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Tu sesión expiró. Entra de nuevo." };
  const membership = await fetchMembership(supabase, user.id);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return { ok: false, message: "Solo un administrador puede usar el simulador." };
  }
  const { data: org } = await supabase
    .from("organizations")
    .select("slug")
    .eq("id", membership.orgId)
    .single();
  if (org?.slug !== config.orgSlug) {
    return {
      ok: false,
      message: "El simulador solo está disponible en la organización de demostración.",
    };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, message: "No hay cambios que enviar." };
  }
  if (rows.length > SIMULATOR_MAX_CHANGES) {
    return { ok: false, message: `Envía como máximo ${SIMULATOR_MAX_CHANGES} cambios a la vez.` };
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const errors = rowErrors(row);
    if (errors.length > 0)
      return { ok: false, message: `${row.sku || "Fila sin código"}: ${errors[0]}` };
    const sku = row.sku.trim();
    if (seen.has(sku)) return { ok: false, message: `El código ${sku} está repetido.` };
    seen.add(sku);
  }

  const records = rows.map((r) => {
    const product = {
      sku: r.sku.trim(),
      name: r.name.trim(),
      price_usd: Math.round(r.priceUsd * 100) / 100,
      stock: Math.round(r.stock * 100) / 100,
    };
    return {
      ...product,
      category: r.category?.trim() ? r.category.trim() : null,
      active: r.active,
      sync_hash: productSyncHash(product),
    };
  });

  try {
    const response = await fetch(`${apiUrl()}/v1/sync/products`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.apiKey },
      body: JSON.stringify({
        kind: "products",
        batch_id: randomUUID(),
        sent_at: new Date().toISOString(),
        full_reconciliation: false,
        records,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429) {
      return { ok: false, message: "Demasiados envíos seguidos. Espera un minuto." };
    }
    if (response.status === 401) {
      return { ok: false, message: "La clave del simulador no es válida en este servidor." };
    }
    if (response.status !== 200) {
      return { ok: false, message: "La API rechazó el envío. Revisa los valores." };
    }
    const body = (await response.json()) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    return {
      ok: true,
      outcome: {
        received: n(body.received),
        inserted: n(body.inserted),
        updated: n(body.updated),
        unchanged: n(body.unchanged),
      },
    };
  } catch {
    return { ok: false, message: "No se pudo contactar a la API. Inténtalo de nuevo." };
  }
}
