import type { MetadataRoute } from "next";

/** Manifiesto de la PWA: la app se instala y abre directamente en el catálogo. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "ERP Web Bridge · Catálogo B2B",
    short_name: "ERP Bridge",
    description: "Catálogo B2B multimoneda (USD y Bs) conectado al ERP de tu proveedor.",
    lang: "es",
    start_url: "/catalogo",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#ffffff",
    theme_color: "#047857",
    categories: ["business", "shopping"],
    icons: [
      { src: "/pwa-icon/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/pwa-icon/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
