"use server";

import { formatBs } from "@erp-web-bridge/shared-types";
import { parseRateInput } from "../../lib/admin";
import { apiUrl } from "../../lib/api-url";
import { fetchMembership } from "../../lib/catalog";
import type { FormState } from "../../lib/form-state";
import { createClient } from "../../lib/supabase/server";

/** Fija la tasa manual por la API (solo owner/admin; la API y RLS lo vuelven a comprobar). */
export async function setExchangeRate(_prev: FormState, formData: FormData): Promise<FormState> {
  const rate = parseRateInput(String(formData.get("rate") ?? ""));
  if (rate === null) {
    return { error: "Escribe una tasa válida: un número mayor que 0 con hasta 4 decimales." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Tu sesión expiró. Entra de nuevo." };
  const membership = await fetchMembership(supabase, user.id);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return { error: "Solo un administrador puede cambiar la tasa." };
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { error: "Tu sesión expiró. Entra de nuevo." };

  try {
    const response = await fetch(`${apiUrl()}/v1/orgs/${membership.orgId}/exchange-rate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ rate_bs: rate }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 201)
      return { error: null, info: `Tasa actualizada a ${formatBs(rate)}.` };
    if (response.status === 429) return { error: "Demasiados cambios seguidos. Espera un minuto." };
    if (response.status === 403) return { error: "Solo un administrador puede cambiar la tasa." };
    return { error: "No se pudo guardar la tasa. Inténtalo de nuevo." };
  } catch {
    return { error: "No se pudo contactar al servidor. Inténtalo de nuevo." };
  }
}
