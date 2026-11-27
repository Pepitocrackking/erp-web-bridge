#!/usr/bin/env node
// Comando único de demo: levanta TODO el sistema desde un clon limpio y comprueba que el flujo
// completo funciona (pedido en la web -> agente real -> borrador en el ERP -> panel).
//
//   pnpm demo              levanta todo y, al final, verifica el flujo de punta a punta
//   pnpm demo:stop         detiene API, web, agente, Supabase y el sandbox de Saint (conserva los datos)
//   pnpm demo status       qué está corriendo
//   pnpm demo check        repite solo la verificación del flujo (con todo ya levantado)
//   pnpm demo --reset      además restablece la base de Supabase al seed antes de empezar
//   pnpm demo --no-agent   no arranca el agente (si no tienes Go); --no-check omite la verificación
//
// Solo usa módulos integrados de Node (funciona antes de `pnpm install`) y corre igual en Windows,
// macOS y Linux. Requisitos: Docker en marcha, Node >= 24, pnpm >= 12 y (para el agente) Go.
// Todo es de DESARROLLO: claves y contraseñas públicas del seed; nunca en producción (docs/security.md).

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_DIR = path.join(ROOT, ".demo");
const STATE_FILE = path.join(DEMO_DIR, "state.json");
const IS_WIN = process.platform === "win32";

const API_PORT = 3001;
const WEB_PORT = 3100;
const API_URL = `http://localhost:${API_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;
const SUPABASE_URL = "http://127.0.0.1:54321";
const DB_CONTAINER = "supabase_db_erp-web-bridge";

// Credenciales de DESARROLLO del seed y del sandbox (públicas, ver docs/security.md).
const DEMO_ORG_ID = "b0000000-0000-4000-8000-00000000000a";
const AGENT_KEY = "erp_dev_demo_saint_key";
const BUYER = { email: "cliente@demo-saint.test", password: "demo1234" };
const ADMIN = { email: "admin@demo-saint.test", password: "demo1234" };
const SAINT_AGENT_DSN =
  "sqlserver://erp_agent:Agent_Demo_2026%21@localhost:14330?database=SAINT_DEMO&encrypt=disable";

// ---------------------------------------------------------------------------
// Funciones puras (probadas en scripts/demo.test.mjs)
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { command: "up", reset: false, noAgent: false, noCheck: false, help: false, unknown: [] };
  for (const arg of argv) {
    if (["up", "down", "status", "check"].includes(arg) && out.command === "up") out.command = arg;
    else if (arg === "--reset") out.reset = true;
    else if (arg === "--no-agent") out.noAgent = true;
    else if (arg === "--no-check") out.noCheck = true;
    else if (arg === "-h" || arg === "--help" || arg === "help") out.help = true;
    else out.unknown.push(arg);
  }
  return out;
}

/** Las variables NEXT_PUBLIC_* de .env.example (lo único que necesita la web para compilar y arrancar). */
export function publicEnvLines(envExample) {
  return envExample
    .split(/\r?\n/)
    .filter((line) => /^NEXT_PUBLIC_[A-Z_]+=\S/.test(line))
    .map((line) => line.trim());
}

export function readEnvValue(text, key) {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  return m ? m[1].trim() : null;
}

export function nodeVersionOk(version, min = 24) {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  return Number.isFinite(major) && major >= min;
}

/** Rutas con barras normales: así el YAML sirve igual en Windows. */
const slash = (p) => p.replaceAll("\\", "/");

export function agentYaml({ apiUrl, apiKey, dsn, mappingFile, storePath, logFile }) {
  return [
    "# Generado por `pnpm demo`: agente local de demostración contra el sandbox de Saint. No se versiona.",
    "api:",
    `  url: ${apiUrl}`,
    `  api_key: ${apiKey}`,
    "erp:",
    "  type: saint",
    "  saint:",
    `    dsn: "${dsn}"`,
    `    mapping_file: ${slash(mappingFile)}`,
    "sync:",
    "  interval: 10s # ciclos cortos para que el demo se vea rápido",
    "  reconcile_interval: 0s # sin reconciliación diaria: no deshace lo que se edite en el simulador",
    "heartbeat:",
    "  interval: 10s",
    "store:",
    `  path: ${slash(storePath)}`,
    "log:",
    "  format: text",
    `  file: ${slash(logFile)}`,
    "",
  ].join("\n");
}

/** ¿Está completa la pila de Supabase (no solo la base de datos, como la deja el CI)? */
export function supabaseStackState(containerNames) {
  const has = (part) => containerNames.some((n) => n.startsWith(`supabase_${part}_`));
  const required = ["db", "kong", "rest", "realtime", "auth"];
  const missing = required.filter((p) => !has(p));
  if (missing.length === 0) return "complete";
  if (missing.length === required.length) return "stopped";
  return "partial";
}

// ---------------------------------------------------------------------------
// Utilidades de ejecución
// ---------------------------------------------------------------------------

const step = (n, total, text) => console.log(`\n[${n}/${total}] ${text}`);
const ok = (text) => console.log(`  ✔ ${text}`);
const warn = (text) => console.log(`  ! ${text}`);
class DemoError extends Error {}
const fail = (text) => {
  throw new DemoError(text);
};

function run(cmd, args, { cwd = ROOT, env = {}, capture = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: IS_WIN, // pnpm y go son .cmd/.exe en Windows
  });
  if (r.status !== 0 && !allowFail) {
    fail(`falló: ${cmd} ${args.join(" ")}${capture && r.stderr ? `\n${r.stderr.trim()}` : ""}`);
  }
  return r;
}

const has = (cmd, args = ["--version"]) => run(cmd, args, { capture: true, allowFail: true }).status === 0;

async function waitFor(label, check, timeoutMs, everyMs = 1500) {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    try {
      const r = await check();
      if (r === true) return;
      last = String(r ?? "");
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  fail(`tiempo agotado esperando ${label}${last ? ` (${last})` : ""}`);
}

const httpOk = (url, init = {}) => async () => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) });
  return res.ok ? true : `HTTP ${res.status}`;
};

const dockerNames = () =>
  run("docker", ["ps", "--format", "{{.Names}}"], { capture: true, allowFail: true }).stdout?.split(/\r?\n/).filter(Boolean) ?? [];

const readState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { pids: {} });
function writeState(state) {
  mkdirSync(DEMO_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!pid || !isAlive(pid)) return;
  if (IS_WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-pid, "SIGTERM"); // el grupo de procesos (el hijo se lanzó con detached)
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ya terminó */
      }
    }
  }
}

function stopOwnProcesses() {
  const state = readState();
  for (const [name, pid] of Object.entries(state.pids ?? {})) {
    if (pid && isAlive(pid)) {
      killTree(pid);
      ok(`detenido ${name} (PID ${pid})`);
    }
  }
  writeState({ pids: {} });
}

/** Lanza un proceso que sigue vivo cuando este comando termina, con su salida en .demo/logs. */
function startDetached(name, cmd, args, { cwd = ROOT, env = {} } = {}) {
  mkdirSync(path.join(DEMO_DIR, "logs"), { recursive: true });
  const out = openSync(path.join(DEMO_DIR, "logs", `${name}.log`), "w");
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    shell: IS_WIN && cmd === "pnpm",
  });
  child.unref();
  const state = readState();
  state.pids[name] = child.pid;
  writeState(state);
  return child.pid;
}

const portFree = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });

function sandboxScript(action) {
  return IS_WIN
    ? run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join("scripts", "saint-sandbox.ps1"), action])
    : run("bash", [path.join("scripts", "saint-sandbox.sh"), action]);
}

function sandboxQuery(sql) {
  const r = spawnSync(
    "docker",
    [
      "exec",
      "saint-sql",
      "bash",
      "-c",
      `/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -d SAINT_DEMO -h -1 -W -b -Q "SET NOCOUNT ON; ${sql}"`,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) fail(`consulta al sandbox de Saint falló: ${r.stderr || r.stdout}`);
  return r.stdout.replaceAll("\r", "").trim();
}

// ---------------------------------------------------------------------------
// Verificación del flujo completo
// ---------------------------------------------------------------------------

async function json(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* no era JSON */
  }
  return { status: res.status, body, text };
}

async function login(anonKey, creds) {
  const r = await json(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (r.status !== 200) fail(`no se pudo iniciar sesión como ${creds.email}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
  return r.body.access_token;
}

export async function check({ withAgent = true } = {}) {
  const envExample = readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const anon = readEnvValue(envExample, "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!anon) fail("no se encontró NEXT_PUBLIC_SUPABASE_ANON_KEY en .env.example");

  console.log("\nVerificación del flujo completo");
  // 1. Los servicios responden.
  const health = await json(`${API_URL}/health`);
  if (health.body?.status !== "ok") fail(`la API no responde bien en ${API_URL}/health`);
  ok("API: /health ok");
  const login_page = await fetch(`${WEB_URL}/login`, { signal: AbortSignal.timeout(8000) });
  const html = await login_page.text();
  if (!login_page.ok || !html.includes("Administrador Demo")) fail("la web no responde o no está en modo demo");
  ok("web: /login responde y ofrece «Entrar como Administrador Demo»");

  const buyerToken = await login(anon, BUYER);
  const adminToken = await login(anon, ADMIN);
  ok("Supabase Auth: inicia sesión el comprador y el administrador del demo");

  if (!withAgent) {
    warn("sin agente (--no-agent): se omite el tramo del ERP");
    return;
  }

  // 2. El agente real está conectado y ya sincronizó el sandbox de Saint.
  const org = await waitForOrg(anon, adminToken);
  ok(`agente conectado (último latido ${org.last_heartbeat_at}) y sincronizado (${org.last_sync_at})`);
  const products = await json(`${SUPABASE_URL}/rest/v1/products?select=erp_sku&org_id=eq.${DEMO_ORG_ID}&is_active=eq.true&limit=1000`, {
    headers: { apikey: anon, authorization: `Bearer ${adminToken}` },
  });
  const inCloud = Array.isArray(products.body) ? products.body.length : 0;
  const inSaint = Number(sandboxQuery("SELECT COUNT(*) FROM SAPROD WHERE Activo = 1"));
  if (!Number.isInteger(inSaint) || inSaint < 1) fail("no se pudo contar los productos activos del sandbox de Saint");
  if (inCloud !== inSaint) fail(`el catálogo en la nube tiene ${inCloud} productos activos y el sandbox de Saint ${inSaint}: aún no terminó de sincronizar`);
  ok(`catálogo: ${inCloud} productos activos en la nube = ${inSaint} activos en SAPROD (Saint)`);

  // 3. Un pedido de la web llega al ERP como BORRADOR.
  const created = await json(`${API_URL}/v1/orgs/${DEMO_ORG_ID}/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${buyerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ items: [{ sku: "P00001", quantity: 1 }], notes: "pedido de verificación de `pnpm demo`" }),
  });
  if (created.status !== 201) fail(`no se pudo crear el pedido: HTTP ${created.status} ${created.text.slice(0, 200)}`);
  const orderId = created.body.id;
  ok(`pedido ${orderId.slice(0, 8)} creado por el comprador: ${created.body.status}`);

  let order = null;
  await waitFor(
    "que el agente lleve el pedido al ERP",
    async () => {
      const r = await json(`${SUPABASE_URL}/rest/v1/web_orders?id=eq.${orderId}&select=status,erp_order_reference,error_detail`, {
        headers: { apikey: anon, authorization: `Bearer ${buyerToken}` },
      });
      order = r.body?.[0];
      if (order?.status === "error") fail(`el ERP rechazó el pedido: ${order.error_detail}`);
      return order?.status === "synced_to_erp" ? true : `estado: ${order?.status}`;
    },
    90_000,
    3000,
  );
  ok(`el pedido pasó a «Enviado al ERP» con la referencia ${order.erp_order_reference}`);

  // 4. De verdad hay un borrador en el sandbox, y lo fiscal no se tocó.
  const draft = sandboxQuery(`SELECT COUNT(*) FROM SAPEDIDO WHERE NumeroWeb = '${orderId}' AND Estado = 'B'`);
  if (draft !== "1") fail(`se esperaba 1 borrador (Estado='B') en SAPEDIDO y hay ${draft}`);
  ok("SAPEDIDO: existe exactamente 1 borrador de ese pedido (Estado = 'B')");
  const fiscal = sandboxQuery("SELECT (SELECT COUNT(*) FROM SAFACT) + (SELECT COUNT(*) FROM SAITEMFAC) + (SELECT COUNT(*) FROM SAACXC)");
  if (fiscal !== "9") fail(`las tablas fiscales deberían seguir con sus 9 filas de ejemplo y tienen ${fiscal}`);
  ok("tablas fiscales (SAFACT, SAITEMFAC, SAACXC) intactas: 9 filas, como en el seed");

  console.log("\nFlujo completo verificado: pedido web → agente real → borrador en Saint → panel.");
}

async function waitForOrg(anon, adminToken) {
  let org = null;
  await waitFor(
    "que el agente se conecte y sincronice",
    async () => {
      const r = await json(`${SUPABASE_URL}/rest/v1/organizations?id=eq.${DEMO_ORG_ID}&select=last_heartbeat_at,last_sync_at`, {
        headers: { apikey: anon, authorization: `Bearer ${adminToken}` },
      });
      org = r.body?.[0];
      const fresh = org?.last_heartbeat_at && Date.now() - Date.parse(org.last_heartbeat_at) < 60_000;
      return fresh && org?.last_sync_at ? true : "el agente aún no reporta";
    },
    120_000,
    3000,
  );
  return org;
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

async function up(opts) {
  const TOTAL = 9;
  step(1, TOTAL, "Comprobando requisitos");
  if (!nodeVersionOk(process.version)) fail(`se necesita Node 24 o superior (tienes ${process.version})`);
  ok(`Node ${process.version}`);
  if (!has("pnpm")) fail("no se encontró pnpm (>= 12): https://pnpm.io/installation");
  ok("pnpm");
  if (!has("docker", ["info"])) fail("Docker no está en marcha: abre Docker Desktop (o el servicio de Docker) y reintenta");
  ok("Docker");
  const goOk = has("go", ["version"]);
  const withAgent = !opts.noAgent && goOk;
  if (!opts.noAgent && !goOk) warn("Go no está instalado: el demo arrancará sin agente real (instala Go 1.26+ o usa --no-agent para silenciar este aviso)");
  else if (goOk) ok("Go (para compilar el agente)");

  step(2, TOTAL, "Instalando dependencias (pnpm install)");
  run("pnpm", ["install", "--frozen-lockfile"]);

  step(3, TOTAL, "Archivos de entorno locales");
  if (!existsSync(path.join(ROOT, ".env"))) {
    copyFileSync(path.join(ROOT, ".env.example"), path.join(ROOT, ".env"));
    ok(".env creado desde .env.example (contraseña del sandbox de Saint)");
  } else ok(".env ya existe");
  const webEnv = path.join(ROOT, "apps", "web", ".env.local");
  if (!existsSync(webEnv)) {
    const lines = publicEnvLines(readFileSync(path.join(ROOT, ".env.example"), "utf8"));
    if (lines.length === 0) fail("no hay variables NEXT_PUBLIC_* en .env.example");
    writeFileSync(webEnv, lines.join("\n") + "\n");
    ok("apps/web/.env.local creado (URL y clave pública de la pila local de Supabase)");
  } else ok("apps/web/.env.local ya existe");

  step(4, TOTAL, "Supabase local (base de datos, Auth y Realtime)");
  stopOwnProcesses(); // libera 3001 y 3100 si quedó un demo anterior
  let state = supabaseStackState(dockerNames());
  if (state === "partial") {
    warn("la pila de Supabase está incompleta (¿la dejó el CI con -x?): se reinicia completa");
    run("pnpm", ["exec", "supabase", "stop"]);
    state = "stopped";
  }
  if (state === "stopped") {
    console.log("  arrancando (la primera vez descarga imágenes: puede tardar varios minutos)…");
    run("pnpm", ["exec", "supabase", "start"]);
  } else ok("la pila ya estaba en marcha");
  if (opts.reset) {
    console.log("  --reset: restableciendo la base al seed…");
    run("pnpm", ["exec", "supabase", "db", "reset"]);
  }
  const anon = readEnvValue(readFileSync(path.join(ROOT, ".env.example"), "utf8"), "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  await waitFor("la API REST de Supabase", httpOk(`${SUPABASE_URL}/rest/v1/`, { headers: { apikey: anon } }), 120_000);
  ok("Supabase responde en http://127.0.0.1:54321");

  step(5, TOTAL, "Sandbox de Saint (SQL Server en Docker con las tablas de Saint)");
  sandboxScript("up");

  step(6, TOTAL, "Compilando (pnpm build)");
  run("pnpm", ["build"]);
  let agentExe = null;
  if (withAgent) {
    mkdirSync(DEMO_DIR, { recursive: true });
    agentExe = path.join(DEMO_DIR, IS_WIN ? "erp-agent.exe" : "erp-agent");
    run("go", ["build", "-o", agentExe, "./cmd/erp-agent"], { cwd: path.join(ROOT, "packages", "erp-agent"), env: { CGO_ENABLED: "0" } });
    ok("agente compilado (Go)");
  }

  step(7, TOTAL, "Arrancando la API y la web");
  for (const [name, port] of [["API", API_PORT], ["web", WEB_PORT]]) {
    if (!(await portFree(port))) fail(`el puerto ${port} (${name}) está ocupado por otro programa; ciérralo y reintenta`);
  }
  startDetached("api", process.execPath, [path.join("apps", "api", "dist", "main.js")], { env: { PORT: String(API_PORT) } });
  await waitFor("la API", httpOk(`${API_URL}/health`), 60_000);
  ok(`API en ${API_URL}`);
  startDetached("web", "pnpm", ["--filter", "@erp-web-bridge/web", "exec", "next", "start", "-p", String(WEB_PORT)], {
    env: { DEMO_MODE: "true", NEXT_TELEMETRY_DISABLED: "1" },
  });
  await waitFor("la web", httpOk(`${WEB_URL}/login`), 90_000);
  ok(`web en ${WEB_URL} (modo demo)`);

  step(8, TOTAL, "Agente local (lee el sandbox de Saint y lo sincroniza)");
  if (withAgent) {
    const logFile = path.join(DEMO_DIR, "logs", "agent.log");
    const config = path.join(DEMO_DIR, "agent.yaml");
    writeFileSync(
      config,
      agentYaml({
        apiUrl: API_URL,
        apiKey: AGENT_KEY,
        dsn: SAINT_AGENT_DSN,
        mappingFile: path.join(ROOT, "infra", "saint-sandbox", "mapping.saint.yaml"),
        storePath: path.join(DEMO_DIR, "agent.db"),
        logFile,
      }),
    );
    rmSync(path.join(DEMO_DIR, "agent.db"), { force: true }); // huellas limpias: la primera pasada sincroniza todo
    startDetached("agent", agentExe, ["-config", config]);
    ok(`agente en marcha (log: ${path.relative(ROOT, logFile)})`);
  } else warn("sin agente: el panel mostrará «Nunca se ha conectado» y los pedidos quedarán pendientes");

  step(9, TOTAL, "Verificación");
  if (opts.noCheck) warn("omitida (--no-check)");
  else await check({ withAgent });

  banner(withAgent);
}

function banner(withAgent) {
  console.log(`
────────────────────────────────────────────────────────────────────────
 Demo lista
────────────────────────────────────────────────────────────────────────
  Web (modo demo)     ${WEB_URL}/login   → «Entrar como Administrador Demo»
  Comprador           ${BUYER.email} / ${BUYER.password}
  Administrador       ${ADMIN.email} / ${ADMIN.password}
  API + documentación ${API_URL}/health      (OpenAPI: ${API_URL}/docs)
  Supabase Studio     http://127.0.0.1:54323
  ${withAgent ? "Agente real         .demo/logs/agent.log" : "Agente              (no arrancado)"}
  Logs de API y web   .demo/logs/

  Guion de demo: README.md → «Guion de demo (5 minutos)»
  Para detenerlo todo: pnpm demo:stop
  Solo desarrollo: estas claves y contraseñas son públicas. Nunca en producción.
`);
}

function down() {
  console.log("Deteniendo el demo…");
  stopOwnProcesses();
  run("docker", ["compose", "down"], { allowFail: true });
  run("pnpm", ["exec", "supabase", "stop"], { allowFail: true });
  console.log("\nListo. Los datos se conservan; `pnpm demo` los reutiliza (o `pnpm demo --reset` para empezar de cero).");
}

async function status() {
  const state = readState();
  for (const name of ["api", "web", "agent"]) {
    const pid = state.pids?.[name];
    console.log(`  ${name.padEnd(6)} ${pid && isAlive(pid) ? `en marcha (PID ${pid})` : "detenido"}`);
  }
  console.log(`  supabase  ${supabaseStackState(dockerNames())}`);
  console.log(`  saint-sql ${dockerNames().includes("saint-sql") ? "en marcha" : "detenido"}`);
}

const HELP = `uso: pnpm demo [up|down|status|check] [--reset] [--no-agent] [--no-check]
  (sin argumentos)   levanta todo y verifica el flujo completo
  down  / pnpm demo:stop   detiene todo, conservando los datos
  status             qué está corriendo
  check              repite solo la verificación del flujo
  --reset            restablece la base de Supabase al seed
  --no-agent         no arranca el agente (si no tienes Go)
  --no-check         no ejecuta la verificación final
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.unknown.length) {
    if (opts.unknown.length) console.error(`argumento desconocido: ${opts.unknown.join(" ")}\n`);
    console.log(HELP);
    return opts.unknown.length ? 2 : 0;
  }
  try {
    if (opts.command === "down") down();
    else if (opts.command === "status") await status();
    else if (opts.command === "check") await check({ withAgent: !opts.noAgent });
    else await up(opts);
    return 0;
  } catch (e) {
    if (e instanceof DemoError) {
      console.error(`\n✖ ${e.message}`);
      console.error("  (logs en .demo/logs/; `pnpm demo:stop` limpia lo que haya quedado en marcha)");
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
