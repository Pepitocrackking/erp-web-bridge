import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { RateAutoStatus } from "@erp-web-bridge/shared-types";
import { APP_CONFIG, type AppConfig } from "../config";
import { DatabaseService } from "../database/database.module";
import { AllSourcesFailedError, checkJump, lookupRate, type RateLookup } from "./rate-lookup";
import { BcvSource, DolarApiSource, type RateSource } from "./rate-sources";

/** Resultado de revisar la tasa de una organización. */
export interface AutoOutcome {
  status: RateAutoStatus;
  detail: string | null;
  provider: string | null;
  rate: number | null;
}

/** Todo lo que se lee/escribe de la tasa tiene 4 decimales (exchange_rates.rate_bs es NUMERIC(12,4)). */
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Tasa de cambio automática. Cada `BCV_CHECK_INTERVAL_SECONDS` busca las organizaciones que la
 * tienen activada y a las que ya les toca (según su propio intervalo), consulta las fuentes UNA vez
 * para todas y aplica el resultado a cada una.
 *
 * Reglas por organización, en este orden:
 * 1. Si ninguna fuente respondió, se conserva la última tasa y se deja `source_failed` (el panel avisa).
 * 2. Si la organización pide respetar la tasa manual y hay una manual de HOY (hora de Caracas),
 *    gana la manual (`manual_priority`). Mañana la automática vuelve.
 * 3. Si la lectura varía más de `BCV_MAX_JUMP_PERCENT` frente a la tasa vigente, se descarta
 *    (`jump_rejected`): casi seguro es una lectura errónea. Un administrador puede forzarla.
 * 4. Si es igual a la vigente, no se escribe nada (`unchanged`); si no, se inserta con source 'bcv'.
 *
 * Varias instancias de la API a la vez no duplican trabajo: cada organización se "reclama" con un
 * UPDATE atómico de `rate_auto_checked_at` antes de procesarla.
 */
@Injectable()
export class RateAutoService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RateAutoService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly sources: RateSource[];

  constructor(
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    const { primaryUrl, fallbackUrl, timeoutMs } = config.bcv;
    this.sources = [new BcvSource(primaryUrl, timeoutMs)];
    if (fallbackUrl) this.sources.push(new DolarApiSource(fallbackUrl, timeoutMs));
  }

  onModuleInit(): void {
    if (!this.config.bcv.schedulerEnabled) return;
    this.timer = setInterval(() => void this.tick(), this.config.bcv.checkIntervalSeconds * 1000);
    this.timer.unref();
    this.log.log(
      `Tasa automática activa: fuentes ${this.sources.map((s) => s.provider).join(" → ")}, ` +
        `revisión cada ${this.config.bcv.checkIntervalSeconds}s`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runDue();
    } catch (err) {
      this.log.error(`La revisión de la tasa falló: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Revisa las organizaciones a las que les toca. Devuelve cuántas se procesaron. */
  async runDue(): Promise<{ processed: number }> {
    const claimed = await this.db.pool.query<{ id: string }>(
      `UPDATE public.organizations
          SET rate_auto_checked_at = now()
        WHERE is_active
          AND rate_auto_enabled
          AND (rate_auto_checked_at IS NULL
               OR rate_auto_checked_at < now() - make_interval(mins => rate_auto_interval_minutes))
        RETURNING id`,
    );
    if (claimed.rowCount === 0) return { processed: 0 };

    const lookup = await this.lookup();
    for (const { id } of claimed.rows) {
      try {
        await this.applyToOrg(id, lookup, { force: false });
      } catch (err) {
        this.log.error(
          `No se pudo aplicar la tasa a la organización ${id}: ${(err as Error).message}`,
        );
      }
    }
    return { processed: claimed.rowCount ?? 0 };
  }

  /** «Actualizar ahora»: consulta las fuentes y aplica el resultado a una organización. */
  async refreshOrg(orgId: string, opts: { force: boolean }): Promise<AutoOutcome> {
    await this.db.pool.query(
      "UPDATE public.organizations SET rate_auto_checked_at = now() WHERE id = $1",
      [orgId],
    );
    return this.applyToOrg(orgId, await this.lookup(), opts);
  }

  private async lookup(): Promise<RateLookup | AllSourcesFailedError> {
    try {
      const got = await lookupRate(this.sources);
      for (const f of got.failures) this.log.warn(`Fuente de tasa fallida: ${f.error}`);
      return got;
    } catch (err) {
      if (err instanceof AllSourcesFailedError) {
        this.log.warn(err.message);
        return err;
      }
      throw err;
    }
  }

  /** Aplica una lectura (o un fallo) a una organización y guarda el resultado. */
  async applyToOrg(
    orgId: string,
    lookup: RateLookup | AllSourcesFailedError,
    opts: { force: boolean },
  ): Promise<AutoOutcome> {
    const outcome = await this.db.withTransaction(async (client) => {
      const org = await client.query<{ rate: number; respect: boolean }>(
        `SELECT exchange_rate_bs::float AS rate, rate_auto_respect_manual AS respect
           FROM public.organizations WHERE id = $1 FOR UPDATE`,
        [orgId],
      );
      const row = org.rows[0];
      if (!row) return null;

      if (lookup instanceof AllSourcesFailedError) {
        return this.outcome("source_failed", lookup.message.slice(0, 480), null, null);
      }
      const rate = round4(lookup.rate);
      const provider = lookup.provider;

      if (row.respect && !opts.force) {
        const last = await client.query<{ source: string; today: boolean }>(
          `SELECT source,
                  (created_at AT TIME ZONE 'America/Caracas')::date
                    = (now() AT TIME ZONE 'America/Caracas')::date AS today
             FROM public.exchange_rates
            WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
          [orgId],
        );
        const l = last.rows[0];
        if (l && l.source === "manual" && l.today) {
          return this.outcome(
            "manual_priority",
            `Hay una tasa manual de hoy; la lectura (${rate}) no se aplicó.`,
            provider,
            rate,
          );
        }
      }

      if (!opts.force) {
        const jump = checkJump(row.rate, rate, this.config.bcv.maxJumpPercent);
        if (!jump.ok) {
          const pct = (jump.changePercent as number).toFixed(1);
          return this.outcome(
            "jump_rejected",
            `La lectura de ${provider} (${rate}) varía ${pct} % frente a la tasa vigente (${row.rate}): no se aplicó.`,
            provider,
            rate,
          );
        }
      }

      if (round4(row.rate) === rate) {
        return this.outcome("unchanged", null, provider, rate);
      }
      await client.query(
        `INSERT INTO public.exchange_rates (org_id, rate_bs, source, set_by)
         VALUES ($1, $2, 'bcv', NULL)`,
        [orgId, rate],
      );
      return this.outcome("ok", null, provider, rate);
    });
    if (!outcome) throw new Error(`Organización ${orgId} no encontrada`);

    await this.db.pool.query(
      `UPDATE public.organizations
          SET rate_auto_status = $2, rate_auto_detail = $3, rate_auto_provider = $4,
              rate_auto_checked_at = now(),
              rate_auto_ok_at = CASE WHEN $2 IN ('ok', 'unchanged') THEN now() ELSE rate_auto_ok_at END
        WHERE id = $1`,
      [orgId, outcome.status, outcome.detail, outcome.provider],
    );
    return outcome;
  }

  private outcome(
    status: RateAutoStatus,
    detail: string | null,
    provider: string | null,
    rate: number | null,
  ): AutoOutcome {
    return { status, detail, provider, rate };
  }
}
