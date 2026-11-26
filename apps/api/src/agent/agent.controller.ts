import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import {
  heartbeatSchema,
  type Heartbeat,
  type HeartbeatResponse,
} from "@erp-web-bridge/shared-types";
import { Agent, ApiKeyGuard, type AgentContext } from "../auth/auth.guards";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { DatabaseService } from "../database/database.module";

@Controller("v1/agent")
@UseGuards(ApiKeyGuard)
export class AgentController {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Latido del agente local. Actualiza `last_heartbeat_at` y `agent_version` de SU organización
   * (la de la x-api-key). Solo si reporta `last_error` deja además una fila en `sync_logs`: un
   * latido por minuto y organización llenaría la bitácora sin aportar nada.
   */
  @Post("heartbeat")
  @HttpCode(200)
  async heartbeat(
    @Agent() agent: AgentContext,
    @Body(new ZodValidationPipe(heartbeatSchema)) body: Heartbeat,
  ): Promise<HeartbeatResponse> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE public.organizations SET last_heartbeat_at = now(), agent_version = $2 WHERE id = $1",
        [agent.orgId, body.agent_version],
      );
      if (body.last_error) {
        await client.query(
          `INSERT INTO public.sync_logs (org_id, direction, entity, records_processed, status, error_detail)
           VALUES ($1, 'erp_to_cloud', 'heartbeat', 0, 'error', $2)`,
          [agent.orgId, body.last_error],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { ok: true, server_time: new Date().toISOString() };
  }
}
