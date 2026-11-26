import { Controller, Get } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { healthSchema, type Health } from "@erp-web-bridge/shared-types";
import { ApiEndpoint } from "./common/openapi";

// Sin rate limit: lo consultan sondas y balanceadores con mucha frecuencia.
@SkipThrottle()
@Controller("health")
export class HealthController {
  @Get()
  @ApiEndpoint({
    tag: "health",
    summary: "Estado del servicio",
    auth: "none",
    response: { status: 200, description: "El servicio responde", schema: healthSchema },
  })
  check(): Health {
    return healthSchema.parse({ status: "ok" });
  }
}
