import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BatchRunner } from "./batch-runner";
import { CustomersSyncService } from "./customers-sync.service";
import { ProductsSyncService } from "./products-sync.service";
import { SyncFailureLogInterceptor } from "./sync-failure-log.interceptor";
import { SyncController } from "./sync.controller";

@Module({
  imports: [AuthModule],
  controllers: [SyncController],
  providers: [BatchRunner, ProductsSyncService, CustomersSyncService, SyncFailureLogInterceptor],
})
export class SyncModule {}
