import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { OfflineBanner, RegisterServiceWorker } from "./pwa";

export const metadata: Metadata = {
  title: "ERP Web Bridge",
  applicationName: "ERP Web Bridge",
  appleWebApp: { capable: true, title: "ERP Bridge", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#047857",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        <OfflineBanner />
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
