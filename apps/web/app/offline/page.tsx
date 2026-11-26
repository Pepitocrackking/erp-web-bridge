export const metadata = { title: "Sin conexión · ERP Web Bridge" };

/** Página que el service worker muestra cuando no hay red y la página pedida no está guardada. */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-bold">Sin conexión</h1>
      <p className="text-slate-600">
        No hay internet y esta página no está guardada en tu dispositivo. Revisa tu conexión: el
        catálogo que ya abriste sigue disponible.
      </p>
      <p>
        <a href="/catalogo" className="underline">
          Ver el último catálogo guardado
        </a>
      </p>
    </main>
  );
}
