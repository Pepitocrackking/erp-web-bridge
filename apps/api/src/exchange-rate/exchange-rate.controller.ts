import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiQuery } from "@nestjs/swagger";
import {
  currentExchangeRateSchema,
  exchangeRateEntrySchema,
  exchangeRateHistoryQuerySchema,
  exchangeRateHistorySchema,
  exchangeRateInputSchema,
  rateAutoRefreshInputSchema,
  rateAutoSettingsInputSchema,
  rateAutoSettingsSchema,
  type CurrentExchangeRate,
  type ExchangeRateEntry,
  type ExchangeRateHistory,
  type ExchangeRateHistoryQuery,
  type ExchangeRateInput,
  type RateAutoRefreshInput,
  type RateAutoSettings,
  type RateAutoSettingsInput,
} from "@erp-web-bridge/shared-types";
import { CurrentUser, JwtGuard, type UserContext } from "../auth/auth.guards";
import { ApiEndpoint } from "../common/openapi";
import { RateLimit } from "../common/rate-limit";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { DatabaseService } from "../database/database.module";
import { RateAutoService } from "./rate-auto.service";

interface EntryRow {
  id: string;
  org_id: string;
  rate_bs: number;
  source: "manual" | "bcv";
  set_by: string | null;
  created_at: Date;
}

const toEntry = (row: EntryRow): ExchangeRateEntry => ({
  ...row,
  created_at: row.created_at.toISOString(),
});

const ENTRY_COLUMNS = "id, org_id, rate_bs::float AS rate_bs, source, set_by, created_at";

/**
 * Tasa de cambio manual (Bs por USD) de una organización. Todo corre como el usuario del JWT, con
 * `SET LOCAL ROLE authenticated`: las políticas RLS de `exchange_rates` deciden quién puede qué,
 * no la API (leen todos los miembros; registra solo owner/admin, a su nombre y como `manual`).
 * El trigger `apply_exchange_rate` copia la tasa nueva a `organizations.exchange_rate_bs`.
 */
@Controller("v1/orgs/:orgId/exchange-rate")
@UseGuards(JwtGuard)
export class ExchangeRateController {
  constructor(
    private readonly db: DatabaseService,
    private readonly auto: RateAutoService,
  ) {}

  /** Fija la tasa. La fuente siempre es `manual` y `set_by` el usuario del token. */
  @Post()
  @RateLimit("strict")
  @ApiEndpoint({
    tag: "exchange-rate",
    summary: "Fijar la tasa de cambio manual",
    description:
      "Registra una tasa (Bs por USD) en el historial; pasa a ser la vigente de la organización. " +
      "Solo owner y admin. La fuente siempre es manual y set_by el usuario del token.",
    auth: "user",
    body: exchangeRateInputSchema,
    response: { status: 201, description: "Tasa registrada", schema: exchangeRateEntrySchema },
    errors: [400, 403],
  })
  async set(
    @Param("orgId", new ParseUUIDPipe()) orgId: string,
    @CurrentUser() user: UserContext,
    @Body(new ZodValidationPipe(exchangeRateInputSchema)) body: ExchangeRateInput,
  ): Promise<ExchangeRateEntry> {
    try {
      const row = await this.db.withUser(user.userId, async (client) => {
        const res = await client.query<EntryRow>(
          `INSERT INTO public.exchange_rates (org_id, rate_bs, source, set_by)
           VALUES ($1, $2, 'manual', $3)
           RETURNING ${ENTRY_COLUMNS}`,
          [orgId, body.rate_bs, user.userId],
        );
        return res.rows[0] as EntryRow;
      });
      return toEntry(row);
    } catch (err) {
      // 42501 = la política RLS rechazó el INSERT: no es admin de esa organización (o no existe).
      if ((err as { code?: string }).code === "42501") {
        throw new ForbiddenException(
          "Solo un administrador de la organización puede fijar la tasa",
        );
      }
      throw err;
    }
  }

  /** Tasa vigente. Cualquier miembro la lee; quien no lo es recibe 404 (no se revela la organización). */
  @Get()
  @ApiEndpoint({
    tag: "exchange-rate",
    summary: "Tasa de cambio vigente",
    description: "La lee cualquier miembro de la organización. Un no miembro recibe 404.",
    auth: "user",
    response: { status: 200, description: "Tasa vigente", schema: currentExchangeRateSchema },
    errors: [400, 404],
  })
  async current(
    @Param("orgId", new ParseUUIDPipe()) orgId: string,
    @CurrentUser() user: UserContext,
  ): Promise<CurrentExchangeRate> {
    const row = await this.db.withUser(user.userId, async (client) => {
      const res = await client.query<{
        org_id: string;
        rate_bs: number;
        source: "manual" | "bcv" | null;
        set_by: string | null;
        set_at: Date | null;
      }>(
        `SELECT o.id AS org_id, o.exchange_rate_bs::float AS rate_bs,
                r.source, r.set_by, r.created_at AS set_at
           FROM public.organizations o
           LEFT JOIN LATERAL (
             SELECT source, set_by, created_at FROM public.exchange_rates
              WHERE org_id = o.id ORDER BY created_at DESC, id DESC LIMIT 1
           ) r ON true
          WHERE o.id = $1`,
        [orgId],
      );
      return res.rows[0];
    });
    if (!row) throw new NotFoundException("Organización no encontrada");
    return { ...row, set_at: row.set_at ? row.set_at.toISOString() : null };
  }

  /** Historial de tasas, de la más reciente a la más antigua, paginado. */
  @Get("history")
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  })
  @ApiQuery({
    name: "offset",
    required: false,
    schema: { type: "integer", minimum: 0, default: 0 },
  })
  @ApiEndpoint({
    tag: "exchange-rate",
    summary: "Historial de tasas de cambio",
    description: "De la más reciente a la más antigua, paginado.",
    auth: "user",
    response: {
      status: 200,
      description: "Página del historial",
      schema: exchangeRateHistorySchema,
    },
    errors: [400, 404],
  })
  async history(
    @Param("orgId", new ParseUUIDPipe()) orgId: string,
    @CurrentUser() user: UserContext,
    @Query(new ZodValidationPipe(exchangeRateHistoryQuerySchema)) query: ExchangeRateHistoryQuery,
  ): Promise<ExchangeRateHistory> {
    const { items, total } = await this.db.withUser(user.userId, async (client) => {
      const list = await client.query<EntryRow>(
        `SELECT ${ENTRY_COLUMNS} FROM public.exchange_rates
          WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
        [orgId, query.limit, query.offset],
      );
      const count = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.exchange_rates WHERE org_id = $1",
        [orgId],
      );
      return { items: list.rows, total: count.rows[0]?.n ?? 0 };
    });
    // Un no miembro no ve filas por RLS: sin filas y sin pertenecer, 404 como en la tasa vigente.
    if (total === 0 && !(await this.isMember(user.userId, orgId))) {
      throw new NotFoundException("Organización no encontrada");
    }
    return { items: items.map(toEntry), total, limit: query.limit, offset: query.offset };
  }

  /** Configuración y estado de la tasa automática. La leen todos los miembros. */
  @Get("auto")
  @ApiEndpoint({
    tag: "exchange-rate",
    summary: "Configuración y estado de la tasa automática (BCV)",
    description: "La lee cualquier miembro. Un no miembro recibe 404.",
    auth: "user",
    response: {
      status: 200,
      description: "Configuración y última revisión",
      schema: rateAutoSettingsSchema,
    },
    errors: [400, 404],
  })
  async autoSettings(
    @Param("orgId", new ParseUUIDPipe()) orgId: string,
    @CurrentUser() user: UserContext,
  ): Promise<RateAutoSettings> {
    const row = await this.readAuto(user.userId, orgId);
    if (!row) throw new NotFoundException("Organización no encontrada");
    return row;
  }

  /** Activa o desactiva la tasa automática y fija su intervalo. Solo owner y admin. */
  @Put("auto")
  @RateLimit("strict")
  @ApiEndpoint({
    tag: "exchange-rate",
    summary: "Configurar la tasa automática (BCV)",
    description:
      "Activa o desactiva la lectura automática de la tasa oficial, su intervalo (15 a 1440 minutos) " +
      "y si una tasa manual de hoy tiene prioridad. Solo owner y admin.",
    auth: "user",
    body: rateAutoSettingsInputSchema,
    response: {
      status: 200,
      description: "Configuración guardada",
      schema: rateAutoSettingsSchema,
    },
    errors: [400, 403],
  })
  async setAutoSettings(
    @Param("orgId", new ParseUUIDPipe()) orgId: string,
    @CurrentUser() user: UserContext,
    @Body(new ZodValidationPipe(rateAutoSettingsInputSchema)) body: RateAutoSettingsInput,
  ): Promise<RateAutoSettings> {
    try {
      await this.db.withUser(user.userId, (client) =>
        client.query("SELECT public.set_rate_auto_settings($1, $2, $3, $4)", [
          orgId,
          body.enabled,
          body.interval_minutes,
          body.respect_manual,
        ]),
      );
    } catch (err) {
      if ((err as { code?: string }).code === "42501") {
        throw new ForbiddenException("Solo un administrador de la organización puede configurarla");
      }
      throw err;
    }
    const row = await this.readAuto(user.userId, orgId);
    if (!row) throw new NotFoundException("Organización no encontrada");
    return row;
  }

  /** «Actualizar ahora»: consulta las fuentes y aplica la tasa a esta organización. Solo owner y admin. */
  @Post("auto/refresh")
  @RateLimit("strict")
  @ApiEndpoint({
    tag: "exchange-rate",
    summary: "Actualizar la tasa ahora desde el BCV",
    description:
      "Consulta las fuentes en este momento y aplica el resultado a la organización, aunque la tasa " +
      "automática esté desactivada. Con force acepta una lectura que varíe más que el umbral y que " +
      "pise una tasa manual de hoy. Solo owner y admin.",
    auth: "user",
    body: rateAutoRefreshInputSchema,
    response: {
      status: 200,
      description: "Resultado de la revisión",
      schema: rateAutoSettingsSchema,
    },
    errors: [400, 403],
  })
  async refresh(
    @Param("orgId", new ParseUUIDPipe()) orgId: string,
    @CurrentUser() user: UserContext,
    @Body(new ZodValidationPipe(rateAutoRefreshInputSchema)) body: RateAutoRefreshInput,
  ): Promise<RateAutoSettings> {
    // Quién es administrador lo decide la base (private.is_org_admin), no la API.
    const isAdmin = await this.db.withUser(user.userId, async (client) => {
      const res = await client.query<{ ok: boolean }>("SELECT private.is_org_admin($1) AS ok", [
        orgId,
      ]);
      return res.rows[0]?.ok === true;
    });
    if (!isAdmin) {
      throw new ForbiddenException(
        "Solo un administrador de la organización puede actualizar la tasa",
      );
    }
    await this.auto.refreshOrg(orgId, { force: body.force });
    const row = await this.readAuto(user.userId, orgId);
    if (!row) throw new NotFoundException("Organización no encontrada");
    return row;
  }

  private readAuto(userId: string, orgId: string): Promise<RateAutoSettings | null> {
    return this.db.withUser(userId, async (client) => {
      const res = await client.query<{
        org_id: string;
        enabled: boolean;
        interval_minutes: number;
        respect_manual: boolean;
        checked_at: Date | null;
        ok_at: Date | null;
        status: RateAutoSettings["status"];
        detail: string | null;
        provider: string | null;
      }>(
        `SELECT id AS org_id, rate_auto_enabled AS enabled,
                rate_auto_interval_minutes AS interval_minutes,
                rate_auto_respect_manual AS respect_manual,
                rate_auto_checked_at AS checked_at, rate_auto_ok_at AS ok_at,
                rate_auto_status AS status, rate_auto_detail AS detail,
                rate_auto_provider AS provider
           FROM public.organizations WHERE id = $1`,
        [orgId],
      );
      const r = res.rows[0];
      if (!r) return null;
      return {
        ...r,
        checked_at: r.checked_at ? r.checked_at.toISOString() : null,
        ok_at: r.ok_at ? r.ok_at.toISOString() : null,
      };
    });
  }

  private isMember(userId: string, orgId: string): Promise<boolean> {
    return this.db.withUser(userId, async (client) => {
      const res = await client.query("SELECT 1 FROM public.organizations WHERE id = $1", [orgId]);
      return res.rowCount === 1;
    });
  }
}
