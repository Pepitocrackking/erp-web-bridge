import { ImageResponse } from "next/og";

/**
 * Iconos de la PWA, generados al compilar (no hay imágenes binarias en el repo). Las rutas terminan
 * en `.png` para que el proxy de sesión las ignore. El icono "maskable" deja un margen seguro
 * porque cada sistema lo recorta con su propia forma.
 */
const ICONS: Record<string, { size: number; maskable: boolean }> = {
  "icon-192.png": { size: 192, maskable: false },
  "icon-512.png": { size: 512, maskable: false },
  "maskable-512.png": { size: 512, maskable: true },
};

export const dynamic = "force-static";

export function generateStaticParams() {
  return Object.keys(ICONS).map((name) => ({ name }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const icon = ICONS[(await params).name];
  if (!icon) return new Response("No encontrado", { status: 404 });

  const text = Math.round(icon.size * (icon.maskable ? 0.3 : 0.38));
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#047857",
        borderRadius: icon.maskable ? 0 : Math.round(icon.size * 0.22),
        color: "#ffffff",
        fontSize: text,
        fontWeight: 800,
        letterSpacing: -2,
      }}
    >
      ERP
    </div>,
    { width: icon.size, height: icon.size },
  );
}
