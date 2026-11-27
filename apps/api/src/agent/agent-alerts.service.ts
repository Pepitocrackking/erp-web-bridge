import { createHmac } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { DatabaseService } from "../database/database.module";

/** Tiempo máximo de espera al webhook: un destino lento no debe frenar la revisión de las demás organizaciones. */
const WEBHOOK_TIMEOUT_MS = 5_000;

type AlertEvent = "agent.offline" | "agent.online";

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  last_heartbeat_at: Date;
}

/**
 * Avisa por webhook (si NOTIFY_WEBHOOK_URL está definida) cuando el agente local de una
 * organización deja de dar señales y cuando vuelve. El panel ya muestra el estado en vivo; esto
 * es para enterarse sin tener el panel abierto.
 *
 * Reglas:
 * - UNA vez por caída y una por recuperación. La memoria vive en `organizations.agent_offline_notified_at`,
 *   no en la API: un reinicio, o varias instancias a la vez, no repiten avisos. Cada aviso se
 *   "reclama" con un UPDATE atómico antes de enviarlo.
 * - Si el webhook falla, la reclamación se deshace y se reintenta en la siguiente revisión.
 * - Solo organizaciones activas que alguna vez se conectaron.
 */
@Injectable()
export class AgentAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AgentAlertsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const { webhookUrl, checkIntervalSeconds, offlineAfterSeconds } = this.config.notify;
    if (!webhookUrl) return;
    this.timer = setInterval(() => void this.tick(), checkIntervalSeconds * 1000);
    this.timer.unref(); // no impide cerrar el proceso
    this.log.log(
      `Aviso de agente sin conexión activo: webhook en ${new URL(webhookUrl).host}, ` +
        `ventana ${offlineAfterSeconds}s, revisión cada ${checkIntervalSeconds}s`,
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
    if (this.running) return; // una revisión lenta no se solapa con la siguiente
    this.running = true;
    try {
      await this.check();
    } catch (err) {
      this.log.error(`La revisión de agentes falló: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Una revisión. Devuelve cuántos avisos de cada tipo se ENVIARON con éxito. */
  async check(): Promise<{ offline: number; online: number }> {
    if (!this.config.notify.webhookUrl) return { offline: 0, online: 0 };
    const windowSeconds = this.config.notify.offlineAfterSeconds;
    let offline = 0;
    let online = 0;

    const down = await this.db.pool.query<OrgRow & { claimed: string; offline_seconds: number }>(
      `UPDATE public.organizations
          SET agent_offline_notified_at = now()
        WHERE is_active
          AND last_heartbeat_at IS NOT NULL
          AND last_heartbeat_at < now() - make_interval(secs => $1::int)
          AND agent_offline_notified_at IS NULL
        RETURNING id, slug, name, last_heartbeat_at,
                  agent_offline_notified_at::text AS claimed,
                  extract(epoch FROM now() - last_heartbeat_at)::int AS offline_seconds`,
      [windowSeconds],
    );
    for (const org of down.rows) {
      const minutes = Math.max(1, Math.round(org.offline_seconds / 60));
      const sent = await this.send("agent.offline", org, {
        offline_for_seconds: org.offline_seconds,
        message: `El agente local de «${org.name}» no da señales desde hace ${minutes} min. El catálogo muestra el último estado válido.`,
      });
      if (sent) offline++;
      else
        await this.db.pool.query(
          `UPDATE public.organizations SET agent_offline_notified_at = NULL
            WHERE id = $1 AND agent_offline_notified_at = $2::timestamptz`,
          [org.id, org.claimed],
        );
    }

    const up = await this.db.pool.query<OrgRow & { was: string }>(
      `WITH due AS (
         SELECT id, agent_offline_notified_at::text AS was
           FROM public.organizations
          WHERE agent_offline_notified_at IS NOT NULL
            AND last_heartbeat_at > agent_offline_notified_at
            AND last_heartbeat_at > now() - make_interval(secs => $1::int)
            FOR UPDATE
       )
       UPDATE public.organizations o
          SET agent_offline_notified_at = NULL
         FROM due
        WHERE o.id = due.id
        RETURNING o.id, o.slug, o.name, o.last_heartbeat_at, due.was`,
      [windowSeconds],
    );
    for (const org of up.rows) {
      const sent = await this.send("agent.online", org, {
        message: `El agente local de «${org.name}» volvió a conectarse.`,
      });
      if (sent) online++;
      else
        await this.db.pool.query(
          `UPDATE public.organizations SET agent_offline_notified_at = $2::timestamptz
            WHERE id = $1 AND agent_offline_notified_at IS NULL`,
          [org.id, org.was],
        );
    }
    return { offline, online };
  }

  /** POST del aviso. true solo si el destino respondió 2xx. Nunca lanza: un fallo se registra y listo. */
  private async send(
    event: AlertEvent,
    org: OrgRow,
    extra: Record<string, unknown>,
  ): Promise<boolean> {
    const { webhookUrl, webhookSecret } = this.config.notify;
    if (!webhookUrl) return false;
    const body = JSON.stringify({
      event,
      sent_at: new Date().toISOString(),
      organization: { id: org.id, slug: org.slug, name: org.name },
      last_heartbeat_at: org.last_heartbeat_at.toISOString(),
      ...extra,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "erp-web-bridge",
      "x-erp-bridge-event": event,
    };
    if (webhookSecret) {
      headers["x-erp-bridge-signature"] =
        `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
    }
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body,
        redirect: "manual", // una redirección no es un éxito ni se sigue hacia otro destino
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (res.status >= 200 && res.status < 300) return true;
      this.log.warn(
        `El webhook respondió ${res.status} al aviso ${event} de ${org.slug}; se reintentará`,
      );
      return false;
    } catch (err) {
      // No se registra la URL completa: puede llevar un token.
      this.log.warn(
        `No se pudo enviar el aviso ${event} de ${org.slug} a ${new URL(webhookUrl).host}: ${(err as Error).message}; se reintentará`,
      );
      return false;
    }
  }
}
