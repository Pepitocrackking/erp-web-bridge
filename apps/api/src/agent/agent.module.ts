import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AgentAlertsService } from "./agent-alerts.service";
import { AgentController } from "./agent.controller";

@Module({
  imports: [AuthModule],
  controllers: [AgentController],
  providers: [AgentAlertsService],
})
export class AgentModule {}
