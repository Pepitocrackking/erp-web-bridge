// Pruebas de las funciones puras de `pnpm demo` (scripts/demo.mjs). Correr con: pnpm test:scripts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentYaml, nodeVersionOk, parseArgs, publicEnvLines, readEnvValue, supabaseStackState } from "./demo.mjs";

describe("parseArgs", () => {
  it("sin argumentos levanta todo", () => {
    assert.deepEqual(parseArgs([]), { command: "up", reset: false, noAgent: false, noCheck: false, help: false, unknown: [] });
  });
  it("subcomandos y banderas", () => {
    assert.equal(parseArgs(["down"]).command, "down");
    assert.equal(parseArgs(["status"]).command, "status");
    assert.equal(parseArgs(["check", "--no-agent"]).noAgent, true);
    const o = parseArgs(["--reset", "--no-check"]);
    assert.equal(o.reset, true);
    assert.equal(o.noCheck, true);
    assert.equal(o.command, "up");
  });
  it("lo desconocido se reporta en vez de ignorarse", () => {
    assert.deepEqual(parseArgs(["--resett"]).unknown, ["--resett"]);
    assert.deepEqual(parseArgs(["borrar"]).unknown, ["borrar"]);
  });
  it("ayuda", () => {
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs(["-h"]).help, true);
  });
});

describe("publicEnvLines / readEnvValue", () => {
  const env = [
    "# comentario",
    "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "# NEXT_PUBLIC_COMENTADA=x",
    "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY=abc.def.ghi",
    "NEXT_PUBLIC_VACIA=",
    "",
  ].join("\r\n");
  it("solo copia las NEXT_PUBLIC_* con valor (la web no debe recibir DATABASE_URL ni nada privado)", () => {
    assert.deepEqual(publicEnvLines(env), ["NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321", "NEXT_PUBLIC_SUPABASE_ANON_KEY=abc.def.ghi"]);
  });
  it("lee un valor, y null si no está", () => {
    assert.equal(readEnvValue(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY"), "abc.def.ghi");
    assert.equal(readEnvValue(env, "NO_EXISTE"), null);
  });
});

describe("nodeVersionOk", () => {
  it("exige Node 24 o superior", () => {
    assert.equal(nodeVersionOk("v24.0.0"), true);
    assert.equal(nodeVersionOk("v26.1.0"), true);
    assert.equal(nodeVersionOk("v22.12.0"), false);
    assert.equal(nodeVersionOk("basura"), false);
  });
});

describe("agentYaml", () => {
  const yaml = agentYaml({
    apiUrl: "http://localhost:3001",
    apiKey: "erp_dev_demo_saint_key",
    dsn: "sqlserver://erp_agent:Agent_Demo_2026%21@localhost:14330?database=SAINT_DEMO&encrypt=disable",
    mappingFile: String.raw`D:\repo\infra\saint-sandbox\mapping.saint.yaml`,
    storePath: String.raw`D:\repo\.demo\agent.db`,
    logFile: String.raw`D:\repo\.demo\logs\agent.log`,
  });
  it("usa barras normales (el YAML no interpreta \ ni \r de una ruta de Windows)", () => {
    assert.ok(yaml.includes("mapping_file: D:/repo/infra/saint-sandbox/mapping.saint.yaml"));
    assert.ok(yaml.includes("path: D:/repo/.demo/agent.db"));
    assert.ok(yaml.includes("file: D:/repo/.demo/logs/agent.log"));
    assert.ok(!yaml.includes("\\"));
  });
  it("usa el login restringido erp_agent y ciclos cortos sin reconciliación diaria", () => {
    assert.ok(yaml.includes("erp_agent:"));
    assert.ok(!/\bsa:/.test(yaml), "el agente nunca conecta como sa");
    assert.ok(yaml.includes("interval: 10s"));
    assert.ok(yaml.includes("reconcile_interval: 0s"));
  });
  it("es YAML válido para el agente: los campos son los que el agente acepta (config estricta)", () => {
    for (const key of ["api:", "erp:", "sync:", "heartbeat:", "store:", "log:"]) assert.ok(yaml.includes(`\n${key}`) || yaml.startsWith(key));
  });
});

describe("supabaseStackState", () => {
  const full = ["supabase_db_erp-web-bridge", "supabase_kong_erp-web-bridge", "supabase_rest_erp-web-bridge", "supabase_realtime_erp-web-bridge", "supabase_auth_erp-web-bridge", "saint-sql"];
  it("completa, parada o parcial (la que deja el CI con -x)", () => {
    assert.equal(supabaseStackState(full), "complete");
    assert.equal(supabaseStackState(["saint-sql"]), "stopped");
    assert.equal(supabaseStackState(["supabase_db_erp-web-bridge", "supabase_auth_erp-web-bridge"]), "partial");
  });
});
