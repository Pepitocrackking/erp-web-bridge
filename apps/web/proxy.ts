import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseEnv } from "./lib/supabase/env";

/** Rutas que exigen sesión. Todo lo demás (portada, login) es público. */
const PROTECTED_PREFIXES = ["/catalogo"];

/**
 * Refresca la sesión de Supabase en cada petición (los Server Components no pueden escribir
 * cookies) y manda al login a quien no tenga sesión en una ruta protegida.
 */
export async function proxy(request: NextRequest) {
  const { url, anonKey } = supabaseEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // Una respuesta que fija cookies de sesión no debe cachearse (ni en un CDN).
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  // getUser() valida el token contra Auth; getSession() solo lee la cookie y no es de fiar aquí.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (!user && isProtected) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    const redirect = NextResponse.redirect(login);
    // Conserva las cookies que el refresco haya podido fijar.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }
  return response;
}

export const config = {
  // Excluye estáticos de Next y archivos con extensión (iconos, manifest, service worker).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)"],
};
