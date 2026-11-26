import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health.controller";
import { SyncModule } from "./sync/sync.module";

@Module({
  imports: [DatabaseModule, AuthModule, SyncModule],
  controllers: [HealthController],
})
export class AppModule {}
