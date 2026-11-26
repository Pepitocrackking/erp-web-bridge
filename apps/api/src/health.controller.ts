import { Controller, Get } from "@nestjs/common";
import { healthSchema, type Health } from "@erp-web-bridge/shared-types";

@Controller("health")
export class HealthController {
  @Get()
  check(): Health {
    return healthSchema.parse({ status: "ok" });
  }
}
