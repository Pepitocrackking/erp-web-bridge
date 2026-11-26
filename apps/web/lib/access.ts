import type { SupabaseClient } from "@supabase/supabase-js";

export type AccessStatus = "pending" | "approved" | "rejected";

export interface AccessRequest {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  taxId: string;
  businessName: string | null;
  status: AccessStatus;
  decisionNote: string | null;
  createdAt: string;
}

export interface CustomerOption {
  id: string;
  code: string;
  name: string;
  taxId: string;
}

const GENERIC_ERROR = "No se pudo completar la operación. Inténtalo de nuevo.";

/** Mensajes para los códigos que lanzan las funciones de la migración 0700. */
const ERRORS: Record<string, string> = {
  unauthenticated: "Tu sesión expiró. Entra de nuevo.",
  invalid_tax_id: "Indica un RIF o cédula válido.",
  org_not_found: "No existe una empresa con ese código.",
  already_member: "Ya tienes acceso a esa empresa.",
  request_not_pending: "Esta solicitud ya fue resuelta.",
  customer_not_found: "El cliente elegido no existe o no está activo.",
  no_matching_customer: "Ningún cliente tiene ese RIF: elige a qué cliente corresponde.",
  ambiguous_customer: "Hay varios clientes con ese RIF: elige a cuál corresponde.",
  forbidden: "No tienes permiso para hacer esto.",
};

/** El error de Postgres/PostgREST trae el código como mensaje; lo desconocido no se muestra. */
export function accessErrorMessage(code: string | undefined): string {
  return (code && ERRORS[code]) || GENERIC_ERROR;
}

/** Igual que `private.normalize_tax_id` en SQL: sin separadores y en mayúsculas. */
export function normalizeTaxId(taxId: string | null | undefined): string {
  return (taxId ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Cliente que sugiere la UI: el único cuyo RIF coincide (null si ninguno o si hay varios). */
export function suggestCustomer(taxId: string, customers: CustomerOption[]): string | null {
  const wanted = normalizeTaxId(taxId);
  if (!wanted) return null;
  const matches = customers.filter((c) => normalizeTaxId(c.taxId) === wanted);
  return matches.length === 1 ? matches[0]!.id : null;
}

interface RequestRow {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  tax_id: string;
  business_name: string | null;
  status: AccessStatus;
  decision_note: string | null;
  created_at: string;
}

const COLUMNS =
  "id, org_id, org_name, email, tax_id, business_name, status, decision_note, created_at";

const toRequest = (r: RequestRow): AccessRequest => ({
  id: r.id,
  orgId: r.org_id,
  orgName: r.org_name,
  email: r.email,
  taxId: r.tax_id,
  businessName: r.business_name,
  status: r.status,
  decisionNote: r.decision_note,
  createdAt: r.created_at,
});

/** Solicitudes del propio usuario (RLS deja a un admin ver también las de su empresa: se filtra). */
export async function fetchMyRequests(
  supabase: SupabaseClient,
  userId: string,
): Promise<AccessRequest[]> {
  const { data, error } = await supabase
    .from("customer_access_requests")
    .select(COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`No se pudieron leer tus solicitudes: ${error.message}`);
  return ((data ?? []) as RequestRow[]).map(toRequest);
}

export async function fetchPendingRequests(
  supabase: SupabaseClient,
  orgId: string,
): Promise<AccessRequest[]> {
  const { data, error } = await supabase
    .from("customer_access_requests")
    .select(COLUMNS)
    .eq("org_id", orgId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`No se pudieron leer las solicitudes: ${error.message}`);
  return ((data ?? []) as RequestRow[]).map(toRequest);
}

/** Clientes activos del ERP para elegir a quién atar al comprador (hasta 1000). */
export async function fetchActiveCustomers(
  supabase: SupabaseClient,
  orgId: string,
): Promise<CustomerOption[]> {
  const { data, error } = await supabase
    .from("b2b_customers")
    .select("id, erp_customer_code, business_name, tax_id")
    .eq("org_id", orgId)
    .eq("is_active", true)
    .order("business_name", { ascending: true })
    .limit(1000);
  if (error) throw new Error(`No se pudieron leer los clientes: ${error.message}`);
  return (data ?? []).map((c) => ({
    id: c.id,
    code: c.erp_customer_code,
    name: c.business_name,
    taxId: c.tax_id,
  }));
}
