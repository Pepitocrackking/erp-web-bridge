import { Module } from "@nestjs/common";
import { AgentModule } from "./agent/agent.module";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { ExchangeRateModule } from "./exchange-rate/exchange-rate.module";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";
import { SyncModule } from "./sync/sync.module";

@Module({
  imports: [DatabaseModule, AuthModule, SyncModule, AgentModule, ExchangeRateModule, OrdersModule],
  controllers: [HealthController],
})
export class AppModule {}
