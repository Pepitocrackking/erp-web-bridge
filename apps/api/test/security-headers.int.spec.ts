import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp, setupDocs } from "../src/setup";
import { config } from "./helpers";

describe("cabeceras de seguridad de la API", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app, config);
    setupDocs(app, { docsEnabled: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const expectHardened = (headers: Record<string, unknown>) => {
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-powered-by"]).toBeUndefined();
  };

  it("una respuesta normal lleva las cabeceras y no se cachea", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expectHardened(res.headers);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("también las respuestas de error (401 con credenciales falsas)", async () => {
    const res = await request(app.getHttpServer())
      .post("/v1/agent/heartbeat")
      .set("x-api-key", "clave-falsa")
      .send({ agent_version: "x" })
      .expect(401);
    expectHardened(res.headers);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("también una ruta que no existe (404)", async () => {
    const res = await request(app.getHttpServer()).get("/no-existe").expect(404);
    expectHardened(res.headers);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("la documentación lleva las cabeceras pero sus archivos estáticos pueden cachearse", async () => {
    const res = await request(app.getHttpServer()).get("/docs").expect(200);
    expectHardened(res.headers);
    expect(res.headers["cache-control"]).not.toBe("no-store");
    await request(app.getHttpServer()).get("/openapi.json").expect(200);
  });
});
