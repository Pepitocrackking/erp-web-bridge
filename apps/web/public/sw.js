/* Service worker de ERP Web Bridge. Archivo propio y sin librerías: es pequeño y se puede auditar.
 *
 * Qué guarda:
 *  - STATIC: el "shell" (página sin conexión, manifiesto, iconos) y los recursos inmutables de
 *    /_next/static/ (cache-first: su URL cambia con cada compilación).
 *  - PAGES: las páginas del catálogo que el usuario ya abrió (/catalogo con sus búsquedas), para
 *    poder verlas sin conexión. Es red primero: con red siempre se muestra lo último.
 *
 * Privacidad: las páginas del catálogo son de un usuario concreto (precios de SU lista). Por eso
 * PAGES se vacía en cuanto se pide /login (cerrar sesión o entrar con otra cuenta pasa siempre por
 * ahí) y también cuando la página manda el mensaje "clear-private" al cerrar sesión. Nunca se
 * guardan respuestas que vienen de una redirección (p. ej. el catálogo sin sesión -> /login),
 * peticiones que no sean GET, ni peticiones RSC/datos de Next.
 */
const VERSION = "v1";
const STATIC = `erpwb-static-${VERSION}`;
const PAGES = `erpwb-pages-${VERSION}`;
const SHELL = [
  "/offline",
  "/manifest.webmanifest",
  "/pwa-icon/icon-192.png",
  "/pwa-icon/icon-512.png",
];
const MAX_PAGES = 30;
const NETWORK_TIMEOUT_MS = 5000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== STATIC && key !== PAGES) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "clear-private") event.waitUntil(caches.delete(PAGES));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Entrar o cerrar sesión: lo guardado era de otro usuario. (También cuando Next lo pide por RSC.)
  if (url.pathname === "/login") event.waitUntil(caches.delete(PAGES));

  // Datos y transiciones de Next, y el propio service worker: siempre a la red.
  if (url.searchParams.has("_rsc") || request.headers.get("RSC")) return;
  if (url.pathname === "/sw.js") return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(navigate(event));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: STATIC });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    caches.open(STATIC).then((cache) => cache.put(request, copy));
  }
  return response;
}

function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function navigate(event) {
  const request = event.request;
  const url = new URL(request.url);
  const cacheable = url.pathname === "/catalogo";
  try {
    const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (cacheable && response.ok && !response.redirected) {
      event.waitUntil(savePage(request.url, response.clone()));
    }
    return response;
  } catch {
    if (cacheable) {
      // Solo la misma URL (misma búsqueda y página): otra no mostraría lo que el usuario pidió.
      const cached = await caches.match(request.url, { cacheName: PAGES });
      if (cached) return fromCache(cached);
    }
    return (await caches.match("/offline", { cacheName: STATIC })) || Response.error();
  }
}

/** La misma respuesta guardada, marcada para que se pueda saber (y probar) que no vino de la red. */
function fromCache(response) {
  const headers = new Headers(response.headers);
  headers.set("x-erpwb-cache", "hit");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function savePage(key, response) {
  const cache = await caches.open(PAGES);
  await cache.put(key, response);
  // Tope de páginas guardadas: se descartan las más antiguas.
  const keys = await cache.keys();
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(old);
}
