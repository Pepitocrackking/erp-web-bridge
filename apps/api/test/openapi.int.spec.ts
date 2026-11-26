import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import SwaggerParser from "@apidevtools/swagger-parser";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { loadConfig } from "../src/config";
import { configureApp, setupDocs } from "../src/setup";

// Un documento JSON arbitrario: las pruebas lo recorren por sus claves, así que `any` es lo honesto aquí.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Operation = {
  tags?: string[];
  summary?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }>;
  requestBody?: { content: Record<string, { schema: Json }> };
  responses: Record<string, { description?: string; content?: Record<string, { schema: Json }> }>;
};
type Doc = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, Record<string, unknown>> };
};

async function build(env: Record<string, string> = {}): Promise<INestApplication> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    setupDocs(app, loadConfig());
    await app.init();
    return app;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("documentación OpenAPI", () => {
  let app: INestApplication;
  let doc: Doc;

  beforeAll(async () => {
    app = await build();
    doc = (await request(app.getHttpServer()).get("/openapi.json").expect(200)).body as Doc;
  });

  afterAll(async () => {
    await app.close();
  });

  it("es un documento OpenAPI 3 válido (lo comprueba swagger-parser)", async () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toMatch(/erp-web-bridge/i);
    await expect(SwaggerParser.validate(structuredClone(doc) as never)).resolves.toBeDefined();
  });

  it("documenta exactamente los endpoints de la API", () => {
    const ops = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(ops.sort()).toEqual(
      [
        "GET /health",
        "POST /v1/sync/products",
        "POST /v1/sync/customers",
        "POST /v1/agent/heartbeat",
        "GET /v1/orgs/{orgId}/exchange-rate",
        "POST /v1/orgs/{orgId}/exchange-rate",
        "GET /v1/orgs/{orgId}/exchange-rate/history",
        "POST /v1/orgs/{orgId}/orders",
        "GET /v1/orders/pending",
        "POST /v1/orders/{orderId}/confirm",
        "POST /v1/orders/{orderId}/fail",
        "POST /v1/orgs/{orgId}/orders/{orderId}/retry",
      ].sort(),
    );
  });

  it("declara los dos esquemas de autenticación: x-api-key del agente y JWT de usuario", () => {
    expect(doc.components.securitySchemes["agent-api-key"]).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "x-api-key",
    });
    expect(doc.components.securitySchemes["user-jwt"]).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  it("cada endpoint (salvo /health) exige el esquema que le corresponde", () => {
    const agent = [
      "/v1/sync/products",
      "/v1/sync/customers",
      "/v1/agent/heartbeat",
      "/v1/orders/pending",
      "/v1/orders/{orderId}/confirm",
      "/v1/orders/{orderId}/fail",
    ];
    const user = [
      "/v1/orgs/{orgId}/exchange-rate",
      "/v1/orgs/{orgId}/exchange-rate/history",
      "/v1/orgs/{orgId}/orders",
      "/v1/orgs/{orgId}/orders/{orderId}/retry",
    ];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const op of Object.values(methods)) {
        if (path === "/health") {
          expect(op.security ?? []).toEqual([]);
        } else if (agent.includes(path)) {
          expect(op.security).toEqual([{ "agent-api-key": [] }]);
        } else {
          expect(user).toContain(path);
          expect(op.security).toEqual([{ "user-jwt": [] }]);
        }
      }
    }
  });

  it("todos los endpoints tienen etiqueta, resumen y respuestas de error documentadas", () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const where = `${method.toUpperCase()} ${path}`;
        expect({ where, tags: op.tags?.length }).toEqual({ where, tags: 1 });
        expect({ where, summary: Boolean(op.summary) }).toEqual({ where, summary: true });
        if (path !== "/health") {
          expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["401", "429"]));
        }
      }
    }
  });

  it("los cuerpos salen de los contratos Zod: el lote de productos tiene sus límites reales", () => {
    const op = doc.paths["/v1/sync/products"]!.post!;
    const schema = op.requestBody!.content["application/json"]!.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.kind).toMatchObject({ enum: ["products"] });
    expect(schema.properties.records).toMatchObject({ type: "array", maxItems: 1000 });
    expect(schema.properties.records.items.properties.sync_hash).toMatchObject({ type: "string" });
    expect(schema.required).toEqual(
      expect.arrayContaining(["batch_id", "sent_at", "kind", "records"]),
    );
  });

  it("el pedido solo admite SKU y cantidad, con sus máximos", () => {
    const schema =
      doc.paths["/v1/orgs/{orgId}/orders"]!.post!.requestBody!.content["application/json"]!.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(["items", "notes"]);
    expect(schema.properties.items).toMatchObject({ minItems: 1, maxItems: 200 });
    expect(Object.keys(schema.properties.items.items.properties).sort()).toEqual([
      "quantity",
      "sku",
    ]);
    expect(schema.properties.items.items.additionalProperties).toBe(false);
  });

  it("documenta las respuestas de éxito con su esquema", () => {
    const sync = doc.paths["/v1/sync/products"]!.post!.responses["200"]!;
    expect(sync.content!["application/json"]!.schema.properties).toHaveProperty("duplicate");
    const created = doc.paths["/v1/orgs/{orgId}/orders"]!.post!.responses["201"]!;
    expect(created.content!["application/json"]!.schema.properties).toHaveProperty("total_usd");
    const pending = doc.paths["/v1/orders/pending"]!.get!.responses["200"]!;
    expect(pending.content!["application/json"]!.schema.properties).toHaveProperty("orders");
  });

  it("documenta los parámetros de ruta y de consulta", () => {
    const pending = doc.paths["/v1/orders/pending"]!.get!;
    expect(pending.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "limit",
          in: "query",
          required: false,
          schema: expect.objectContaining({ minimum: 1, maximum: 500 }),
        }),
      ]),
    );
    const confirm = doc.paths["/v1/orders/{orderId}/confirm"]!.post!;
    expect(confirm.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "orderId", in: "path", required: true }),
      ]),
    );
    const history = doc.paths["/v1/orgs/{orgId}/exchange-rate/history"]!.get!;
    expect(history.parameters!.map((p) => p.name)).toEqual(
      expect.arrayContaining(["orgId", "limit", "offset"]),
    );
  });

  it("sirve la interfaz Swagger UI en /docs", async () => {
    const res = await request(app.getHttpServer()).get("/docs").redirects(1).expect(200);
    expect(res.text).toMatch(/swagger/i);
  });

  it("DOCS_ENABLED=false no publica ni /docs ni /openapi.json", async () => {
    const off = await build({ DOCS_ENABLED: "false" });
    try {
      await request(off.getHttpServer()).get("/openapi.json").expect(404);
      await request(off.getHttpServer()).get("/docs").expect(404);
      await request(off.getHttpServer()).get("/health").expect(200);
    } finally {
      await off.close();
    }
  });
});

describe("entrada estricta (global)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await build();
  });
  afterAll(async () => {
    await app.close();
  });

  it("un cuerpo de más de 5 MB se rechaza con 413 antes de procesarlo", async () => {
    const big = { records: "x".repeat(6 * 1024 * 1024) };
    // La autenticación ocurre después del análisis del cuerpo: no hace falta clave válida.
    await request(app.getHttpServer())
      .post("/v1/sync/products")
      .set("x-api-key", "k")
      .send(big)
      .expect(413);
  });

  it("un JSON mal formado da 400, no 500", async () => {
    await request(app.getHttpServer())
      .post("/v1/sync/products")
      .set("Content-Type", "application/json")
      .set("x-api-key", "k")
      .send('{"records": [')
      .expect(400);
  });

  it("no revela el framework en la cabecera X-Powered-By", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("una ruta que no existe da 404", async () => {
    await request(app.getHttpServer()).get("/v1/no-existe").expect(404);
  });
});
