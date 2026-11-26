import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config";
import { JwksCache } from "./jwks";
import { decodeHeader, JwtError, verifyEs256Jwt, verifyHs256Jwt, type JwtClaims } from "./jwt";

/**
 * Verifica el JWT de un usuario de Supabase Auth, sea cual sea el algoritmo con el que firme:
 *   - ES256: sesiones de proyectos nuevos y del CLI reciente; la clave pública sale del JWKS.
 *   - HS256: secreto compartido (`SUPABASE_JWT_SECRET`), de proyectos antiguos y de las pruebas.
 * Cualquier otro algoritmo (`none`, RS256...) se rechaza; el algoritmo nunca lo elige el token
 * sobre una clave que no le corresponde (ES256 solo con claves EC del JWKS, HS256 solo con el secreto).
 */
@Injectable()
export class JwtVerifier {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jwks: JwksCache,
  ) {}

  async verify(token: string, nowSeconds?: number): Promise<JwtClaims> {
    const header = decodeHeader(token);
    let claims: JwtClaims;
    if (header.alg === "HS256") {
      claims = verifyHs256Jwt(token, this.config.jwtSecret, nowSeconds);
    } else if (header.alg === "ES256") {
      if (typeof header.kid !== "string" || header.kid === "") throw new JwtError("token sin kid");
      const key = await this.jwks.getKey(header.kid);
      if (!key) throw new JwtError("clave desconocida");
      claims = verifyEs256Jwt(token, key, nowSeconds);
    } else {
      throw new JwtError("algoritmo no permitido");
    }
    if (this.config.jwtIssuer && claims.iss !== this.config.jwtIssuer) {
      throw new JwtError("emisor no permitido");
    }
    return claims;
  }
}
