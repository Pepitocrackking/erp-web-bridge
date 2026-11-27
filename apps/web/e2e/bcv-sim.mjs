// Simulador de las fuentes de la tasa BCV para los E2E (puerto 3999).
//   GET  /bcv      -> HTML de la portada con la cifra actual (extracto real de bcv.org.ve)
//   GET  /api      -> JSON estilo DolarAPI
//   POST /control  -> { bcv?: "ok"|"down", api?: "ok"|"down", rate?: number }
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(
  join(dir, "..", "..", "api", "test", "fixtures", "bcv-rates-excerpt.html"),
  "utf8",
);
const state = { bcv: "ok", api: "ok", rate: 40.1234 };

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/control") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      Object.assign(state, JSON.parse(raw || "{}"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state));
    });
    return;
  }
  if (req.url === "/bcv") {
    if (state.bcv === "down") {
      res.statusCode = 503;
      return res.end("mantenimiento");
    }
    res.setHeader("content-type", "text/html");
    return res.end(html.replace("926,35920000", state.rate.toFixed(8).replace(".", ",")));
  }
  if (req.url === "/api") {
    if (state.api === "down") {
      res.statusCode = 500;
      return res.end("{}");
    }
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ promedio: state.rate, fechaActualizacion: "2026-11-27" }));
  }
  res.statusCode = 404;
  res.end("no");
}).listen(3999, "127.0.0.1", () => console.log("bcv-sim en :3999"));
