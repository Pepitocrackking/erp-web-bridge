import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { ApiKeyGuard, JwtGuard } from "./auth.guards";
import { JwksCache } from "./jwks";
import { JwtVerifier } from "./jwt-verifier";

@Module({
  providers: [
    ApiKeyGuard,
    JwtGuard,
    JwtVerifier,
    {
      provide: JwksCache,
      useFactory: (config: AppConfig) => new JwksCache(config.jwksUrl),
      inject: [APP_CONFIG],
    },
  ],
  exports: [ApiKeyGuard, JwtGuard, JwtVerifier, JwksCache],
})
export class AuthModule {}
