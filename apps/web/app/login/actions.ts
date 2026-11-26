"use server";

import { redirect } from "next/navigation";
import { demoAdminCredentials } from "../../lib/demo";
import { createClient } from "../../lib/supabase/server";

export interface LoginState {
  error: string | null;
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Ingresa tu correo y tu contraseña." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  // Mensaje único para no revelar si el correo existe.
  if (error) return { error: "Correo o contraseña incorrectos." };
  redirect("/catalogo");
}

/**
 * "Entrar como Administrador Demo": solo con DEMO_MODE=true en el servidor (se comprueba aquí
 * aunque el botón esté oculto, porque una acción de servidor se puede invocar sin la pantalla).
 */
export async function signInDemo(): Promise<void> {
  const credentials = demoAdminCredentials();
  if (!credentials) redirect("/login");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(credentials);
  if (error) redirect("/login?demo=error");
  redirect("/admin");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
