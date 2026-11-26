"use client";

import { useEffect, useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/** Aviso fijo cuando el navegador no tiene red: lo que se ve puede ser la última versión guardada. */
export function OfflineBanner() {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  if (online) return null;
  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="fixed inset-x-0 top-0 z-50 bg-amber-100 px-4 py-2 text-center text-sm text-amber-900"
    >
      Sin conexión. Estás viendo la última versión guardada; los precios pueden haber cambiado.
    </div>
  );
}

/** Registra el service worker (solo en producción: en desarrollo estorba al recargar en caliente). */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Sin service worker la app funciona igual, solo que sin caché sin conexión.
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}

/** Pide al service worker olvidar las páginas guardadas (al cerrar sesión, antes de salir). */
export function clearPrivateCache() {
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.controller?.postMessage("clear-private");
  }
}
