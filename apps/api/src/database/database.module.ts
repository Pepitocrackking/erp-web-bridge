import { Global, Inject, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { Pool, type PoolClient } from "pg";
import { APP_CONFIG, loadConfig, type AppConfig } from "../config";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  }

  /**
   * Ejecuta `fn` en una transacción como el usuario autenticado (`sub` del JWT ya verificado),
   * con `SET LOCAL ROLE authenticated` y `request.jwt.claims`, igual que PostgREST. Así RLS
   * decide qué ve y qué escribe el usuario; la API no replica esas reglas.
   */
  async withUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated" }),
      ]);
      await client.query("SET LOCAL ROLE authenticated");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }, DatabaseService],
  exports: [APP_CONFIG, DatabaseService],
})
export class DatabaseModule {}
