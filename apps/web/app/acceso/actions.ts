"use server";

import { redirect } from "next/navigation";
import { accessErrorMessage } from "../../lib/access";
import type { FormState } from "../../lib/form-state";
import { createClient } from "../../lib/supabase/server";

export async function requestAccess(_prev: FormState, formData: FormData): Promise<FormState> {
  const slug = String(formData.get("empresa") ?? "").trim();
  const taxId = String(formData.get("taxId") ?? "").trim();
  const businessName = String(formData.get("businessName") ?? "").trim();
  if (!slug) return { error: "Escribe el código de la empresa." };
  if (!taxId) return { error: "Escribe tu RIF o cédula." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("request_customer_access", {
    p_org_slug: slug,
    p_tax_id: taxId,
    p_business_name: businessName || null,
  });
  if (error) return { error: accessErrorMessage(error.message) };
  redirect("/acceso");
}
