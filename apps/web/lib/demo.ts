/**
 * Modo demo: un botón que entra como administrador de la organización de demostración, sin
 * registro. SOLO existe si el servidor se arranca con `DEMO_MODE=true`; en producción real debe
 * estar apagado, porque equivale a regalar una cuenta de administrador.
 *
 * Es una variable de entorno de servidor (sin `NEXT_PUBLIC_`): nunca llega al navegador, y tanto
 * la pantalla como la acción de servidor la comprueban (ocultar el botón no basta).
 */
export function isDemoMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE === "true";
}

/** Credenciales del administrador demo (por defecto, el usuario del seed local), o null fuera del modo demo. */
export function demoAdminCredentials(
  env: Record<string, string | undefined> = process.env,
): { email: string; password: string } | null {
  if (!isDemoMode(env)) return null;
  return {
    email: env.DEMO_ADMIN_EMAIL || "admin@demo-saint.test",
    password: env.DEMO_ADMIN_PASSWORD || "demo1234",
  };
}
