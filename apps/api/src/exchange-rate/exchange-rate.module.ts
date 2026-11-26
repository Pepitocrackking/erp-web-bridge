import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ExchangeRateController } from "./exchange-rate.controller";

@Module({ imports: [AuthModule], controllers: [ExchangeRateController] })
export class ExchangeRateModule {}
