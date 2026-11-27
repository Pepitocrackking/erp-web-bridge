import path from "node:path";
import { fileURLToPath } from "node:url";

// Solo el build de la imagen de Docker (apps/web/Dockerfile) define NEXT_OUTPUT=standalone: Next
// empaqueta entonces un servidor mínimo con solo las dependencias que usa. En desarrollo, en las
// pruebas E2E y con `next start` no cambia nada.
const standalone = process.env.NEXT_OUTPUT === "standalone";

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(standalone
    ? {
        output: "standalone",
        // En un monorepo, rastrear desde la raíz para que incluya shared-types y anide la app en apps/web.
        outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      }
    : {}),
  async headers() {
    return [
      {
        // El service worker nunca debe quedar en la caché del navegador: si no, una versión
        // nueva tardaría días en llegar. `Service-Worker-Allowed` deja su alcance en toda la app.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
