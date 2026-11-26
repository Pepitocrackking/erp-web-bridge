import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AgentOrdersController, OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  imports: [AuthModule],
  controllers: [OrdersController, AgentOrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
