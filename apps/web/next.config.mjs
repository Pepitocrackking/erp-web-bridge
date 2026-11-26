/** @type {import('next').NextConfig} */
const nextConfig = {
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
