"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { accessErrorMessage } from "../../../lib/access";
import { createClient } from "../../../lib/supabase/server";

const PAGE = "/admin/solicitudes";

function back(params: Record<string, string>): never {
  redirect(`${PAGE}?${new URLSearchParams(params).toString()}`);
}

export async function approveRequest(formData: FormData) {
  const requestId = String(formData.get("requestId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_access_request", {
    p_request_id: requestId,
    p_customer_id: customerId || null,
  });
  if (error) back({ error: accessErrorMessage(error.message), id: requestId });
  revalidatePath(PAGE);
  back({ ok: "Solicitud aprobada." });
}

export async function rejectRequest(formData: FormData) {
  const requestId = String(formData.get("requestId") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_access_request", {
    p_request_id: requestId,
    p_note: note || null,
  });
  if (error) back({ error: accessErrorMessage(error.message), id: requestId });
  revalidatePath(PAGE);
  back({ ok: "Solicitud rechazada." });
}
