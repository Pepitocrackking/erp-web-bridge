import { Module } from "@nestjs/common";
import { ApiKeyGuard, JwtGuard } from "./auth.guards";

@Module({ providers: [ApiKeyGuard, JwtGuard], exports: [ApiKeyGuard, JwtGuard] })
export class AuthModule {}
