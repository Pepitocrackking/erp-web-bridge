import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BatchRunner } from "./batch-runner";
import { ProductsSyncService } from "./products-sync.service";
import { SyncController } from "./sync.controller";

@Module({
  imports: [AuthModule],
  controllers: [SyncController],
  providers: [BatchRunner, ProductsSyncService],
})
export class SyncModule {}
