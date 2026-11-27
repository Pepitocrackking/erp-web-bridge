import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ExchangeRateController } from "./exchange-rate.controller";
import { RateAutoService } from "./rate-auto.service";

@Module({
  imports: [AuthModule],
  controllers: [ExchangeRateController],
  providers: [RateAutoService],
  exports: [RateAutoService],
})
export class ExchangeRateModule {}
