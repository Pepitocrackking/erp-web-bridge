"use server";

import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import type { FormState } from "../../lib/form-state";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;

export async function register(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const empresa = String(formData.get("empresa") ?? "").trim();
  if (!EMAIL.test(email)) return { error: "Escribe un correo válido." };
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { error: `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.` };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    // No se distingue "ya existe" de otros fallos para no revelar qué correos tienen cuenta.
    return { error: "No se pudo crear la cuenta. Si ya tienes una, entra con tu contraseña." };
  }
  if (!data.session) {
    return {
      error: null,
      info: "Te enviamos un correo para confirmar tu cuenta. Después de confirmarlo, entra y solicita acceso.",
    };
  }
  redirect(empresa ? `/acceso?empresa=${encodeURIComponent(empresa)}` : "/acceso");
}
