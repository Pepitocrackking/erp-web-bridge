import { Module } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AgentModule } from "./agent/agent.module";
import { AuthModule } from "./auth/auth.module";
import { limitFor } from "./common/rate-limit";
import { APP_CONFIG, type AppConfig } from "./config";
import { DatabaseModule } from "./database/database.module";
import { ExchangeRateModule } from "./exchange-rate/exchange-rate.module";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";
import { SyncModule } from "./sync/sync.module";

@Module({
  imports: [
    DatabaseModule,
    // Rate limit por IP y por ruta. El guard es global y corre antes que los de autenticación,
    // así que también frena los intentos con credenciales falsas. El límite de cada ruta sale de
    // su grupo (`@RateLimit`) y de la configuración.
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const reflector = new Reflector();
        return {
          errorMessage: "Demasiadas solicitudes. Reintenta más tarde.",
          throttlers: [
            {
              name: "default",
              ttl: config.rateLimit.windowSeconds * 1000,
              limit: (context) => limitFor(reflector, config.rateLimit, context),
            },
          ],
        };
      },
    }),
    AuthModule,
    SyncModule,
    AgentModule,
    ExchangeRateModule,
    OrdersModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
