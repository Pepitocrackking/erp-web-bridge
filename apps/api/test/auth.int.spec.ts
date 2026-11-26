import "reflect-metadata";
import { createHmac, generateKeyPairSync, sign as cryptoSign, type JsonWebKey } from "node:crypto";
import { Controller, Get, UseGuards, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { Pool } from "pg";
import {
  Agent,
  ApiKeyGuard,
  CurrentUser,
  JwtGuard,
  type AgentContext,
  type UserContext,
} from "../src/auth/auth.guards";
import { AuthModule } from "../src/auth/auth.module";
import { JwksCache } from "../src/auth/jwks";
import { DatabaseModule, DatabaseService } from "../src/database/database.module";
import {
  cleanup,
  createStaffUser,
  createTenant,
  newPool,
  signJwt,
  userToken,
  type TestTenant,
} from "./helpers";

// Rutas solo de prueba: las reales llegan en 4.2 en adelante.
@Controller("t")
class ProbeController {
  constructor(private readonly db: DatabaseService) {}

  @Get("agent")
  @UseGuards(ApiKeyGuard)
  agent(@Agent() agent: AgentContext) {
    return agent;
  }

  @Get("me")
  @UseGuards(JwtGuard)
  me(@CurrentUser() user: UserContext) {
    return user;
  }

  /** Lee organizations como el usuario, bajo RLS: devuelve solo las que ve. */
  @Get("orgs")
  @UseGuards(JwtGuard)
  async orgs(@CurrentUser() user: UserContext) {
    return this.db.withUser(user.userId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM public.organizations ORDER BY id",
      );
      return rows.map((r) => r.id);
    });
  }
}

// Claves ES256 como las que publica Supabase Auth en su JWKS (el servidor real no hace falta).
const esKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const esKid = "kid-de-prueba";
const jwks = {
  keys: [
    {
      ...(esKey.publicKey.export({ format: "jwk" }) as JsonWebKey),
      kid: esKid,
      alg: "ES256",
      use: "sig",
    },
  ],
};

function esToken(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "ES256", typ: "JWT", kid: esKid },
  key = esKey.privateKey,
) {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const data = `${b64(header)}.${b64(claims)}`;
  const sig = cryptoSign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return `${data}.${sig.toString("base64url")}`;
}

describe("autenticación (Postgres real)", () => {
  let app: INestApplication;
  let pool: Pool;
  let a: TestTenant;
  let b: TestTenant;
  let inactive: TestTenant;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    pool = newPool();
    a = await createTenant(pool);
    b = await createTenant(pool);
    inactive = await createTenant(pool, { isActive: false });
    userA = await createStaffUser(pool, a.orgId);
    userB = await createStaffUser(pool, b.orgId);

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, AuthModule],
      controllers: [ProbeController],
    })
      .overrideProvider(JwksCache)
      .useValue(
        new JwksCache("http://jwks.test/keys", async () => ({
          ok: true,
          status: 200,
          json: async () => jwks,
        })),
      )
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await cleanup(pool, [a.orgId, b.orgId, inactive.orgId], [userA, userB]);
    await pool.end();
  });

  const http = () => request(app.getHttpServer());

  describe("x-api-key", () => {
    it("acepta una clave válida y resuelve la organización de esa clave", async () => {
      const res = await http().get("/t/agent").set("x-api-key", a.apiKey).expect(200);
      expect(res.body).toEqual({ orgId: a.orgId, slug: a.slug });
      const resB = await http().get("/t/agent").set("x-api-key", b.apiKey).expect(200);
      expect(resB.body.orgId).toBe(b.orgId);
    });

    it("rechaza sin clave, con clave desconocida o vacía", async () => {
      await http().get("/t/agent").expect(401);
      await http().get("/t/agent").set("x-api-key", "no-existe").expect(401);
      await http().get("/t/agent").set("x-api-key", "").expect(401);
    });

    it("rechaza la clave de una organización inactiva con el mismo mensaje que una desconocida", async () => {
      const off = await http().get("/t/agent").set("x-api-key", inactive.apiKey).expect(401);
      const unknown = await http().get("/t/agent").set("x-api-key", "no-existe").expect(401);
      expect(off.body).toEqual(unknown.body);
    });

    it("no acepta el hash guardado como si fuera la clave", async () => {
      const { rows } = await pool.query<{ api_key_hash: string }>(
        "SELECT api_key_hash FROM public.organizations WHERE id = $1",
        [a.orgId],
      );
      await http().get("/t/agent").set("x-api-key", rows[0]!.api_key_hash).expect(401);
    });

    it("rechaza una clave demasiado larga y una clave repetida", async () => {
      await http().get("/t/agent").set("x-api-key", "x".repeat(300)).expect(401);
      await http().get("/t/agent").set("x-api-key", [a.apiKey, a.apiKey].join(",")).expect(401);
    });

    it("ignora un org_id enviado por el cliente (la organización sale de la clave)", async () => {
      const res = await http()
        .get(`/t/agent?org_id=${b.orgId}`)
        .set("x-api-key", a.apiKey)
        .set("x-org-id", b.orgId)
        .expect(200);
      expect(res.body.orgId).toBe(a.orgId);
    });
  });

  describe("JWT de usuario", () => {
    it("acepta un token válido", async () => {
      const res = await http()
        .get("/t/me")
        .set("Authorization", `Bearer ${userToken(userA)}`)
        .expect(200);
      expect(res.body).toEqual({ userId: userA });
    });

    it("rechaza sin cabecera, sin Bearer, firmado con otro secreto, vencido, anon y service_role", async () => {
      const exp = Math.floor(Date.now() / 1000);
      await http().get("/t/me").expect(401);
      await http().get("/t/me").set("Authorization", userToken(userA)).expect(401);
      const bad = signJwt(
        { sub: userA, role: "authenticated", exp: exp + 60 },
        "otro-secreto-distinto-de-32-caracteres!!",
      );
      await http().get("/t/me").set("Authorization", `Bearer ${bad}`).expect(401);
      const old = signJwt({ sub: userA, role: "authenticated", exp: exp - 10 });
      await http().get("/t/me").set("Authorization", `Bearer ${old}`).expect(401);
      const anon = signJwt({ sub: userA, role: "anon", exp: exp + 60 });
      await http().get("/t/me").set("Authorization", `Bearer ${anon}`).expect(401);
      const svc = signJwt({ role: "service_role", exp: exp + 60 });
      await http().get("/t/me").set("Authorization", `Bearer ${svc}`).expect(401);
    });

    it("rechaza alg none", async () => {
      const none = signJwt(
        { sub: userA, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 60 },
        "",
        {
          alg: "none",
          typ: "JWT",
        },
      );
      await http().get("/t/me").set("Authorization", `Bearer ${none}`).expect(401);
    });

    it("una x-api-key no sirve como JWT ni al revés", async () => {
      await http().get("/t/me").set("x-api-key", a.apiKey).expect(401);
      await http()
        .get("/t/agent")
        .set("Authorization", `Bearer ${userToken(userA)}`)
        .expect(401);
    });
  });

  describe("JWT ES256 (el que emite Supabase Auth con claves asimétricas)", () => {
    const exp = () => Math.floor(Date.now() / 1000) + 60;

    it("acepta un token firmado con la clave del JWKS", async () => {
      const token = esToken({ sub: userA, role: "authenticated", exp: exp() });
      const res = await http().get("/t/me").set("Authorization", `Bearer ${token}`).expect(200);
      expect(res.body).toEqual({ userId: userA });
    });

    it("rechaza firma ajena, kid desconocido, sin kid, vencido y rol anon", async () => {
      const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const claims = { sub: userA, role: "authenticated", exp: exp() };
      const bad = [
        esToken(claims, undefined, other.privateKey),
        esToken(claims, { alg: "ES256", typ: "JWT", kid: "no-existe" }),
        esToken(claims, { alg: "ES256", typ: "JWT" }),
        esToken({ ...claims, exp: Math.floor(Date.now() / 1000) - 5 }),
        esToken({ ...claims, role: "anon" }),
      ];
      for (const token of bad) {
        await http().get("/t/me").set("Authorization", `Bearer ${token}`).expect(401);
      }
    });

    it("no se deja engañar con confusión de algoritmo", async () => {
      const claims = { sub: userA, role: "authenticated", exp: exp() };
      // HS256 firmado usando como "secreto" la clave pública del JWKS (ataque clásico).
      const publicPem = esKey.publicKey.export({ type: "spki", format: "pem" }).toString();
      const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const data = `${b64({ alg: "HS256", typ: "JWT", kid: esKid })}.${b64(claims)}`;
      const confused = `${data}.${createHmac("sha256", publicPem).update(data).digest("base64url")}`;
      await http().get("/t/me").set("Authorization", `Bearer ${confused}`).expect(401);
      // Un ES256 con encabezado alg=none o RS256 tampoco.
      await http()
        .get("/t/me")
        .set("Authorization", `Bearer ${esToken(claims, { alg: "RS256", kid: esKid })}`)
        .expect(401);
      await http()
        .get("/t/me")
        .set("Authorization", `Bearer ${esToken(claims, { alg: "none", kid: esKid })}`)
        .expect(401);
    });

    it("el HS256 con el secreto compartido sigue valiendo", async () => {
      await http()
        .get("/t/me")
        .set("Authorization", `Bearer ${userToken(userA)}`)
        .expect(200);
    });
  });

  describe("RLS con el usuario del JWT", () => {
    it("cada usuario ve solo su organización", async () => {
      const resA = await http()
        .get("/t/orgs")
        .set("Authorization", `Bearer ${userToken(userA)}`)
        .expect(200);
      expect(resA.body).toEqual([a.orgId]);
      const resB = await http()
        .get("/t/orgs")
        .set("Authorization", `Bearer ${userToken(userB)}`)
        .expect(200);
      expect(resB.body).toEqual([b.orgId]);
    });

    it("un usuario autenticado sin membresía no ve ninguna organización", async () => {
      const { rows } = await pool.query<{ id: string }>("SELECT gen_random_uuid() AS id");
      const lonely = rows[0]!.id;
      await pool.query(
        `INSERT INTO auth.users (id, aud, role, email) VALUES ($1, 'authenticated', 'authenticated', $2)`,
        [lonely, `${lonely}@test.local`],
      );
      try {
        const res = await http()
          .get("/t/orgs")
          .set("Authorization", `Bearer ${userToken(lonely)}`)
          .expect(200);
        expect(res.body).toEqual([]);
      } finally {
        await pool.query("DELETE FROM auth.users WHERE id = $1", [lonely]);
      }
    });
  });
});
