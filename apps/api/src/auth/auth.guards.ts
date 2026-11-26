import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { DatabaseService } from "../database/database.module";
import { hashApiKey, hashesEqual } from "./api-key";
import { JwtError } from "./jwt";
import { JwtVerifier } from "./jwt-verifier";

/** Organización autenticada por x-api-key. El `orgId` solo sale de aquí, nunca del cuerpo. */
export interface AgentContext {
  orgId: string;
  slug: string;
}

/** Usuario autenticado por JWT. */
export interface UserContext {
  userId: string;
}

export interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  agent?: AgentContext;
  user?: UserContext;
}

// Mensaje único: no se revela si la clave no existe o la organización está inactiva.
const DENIED = "Credenciales inválidas";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers["x-api-key"];
    // Una clave repetida llega como arreglo: se rechaza en vez de elegir una.
    if (typeof header !== "string" || header.length === 0 || header.length > 256) {
      throw new UnauthorizedException(DENIED);
    }
    const hash = hashApiKey(header);
    const { rows } = await this.db.pool.query<{ id: string; slug: string; api_key_hash: string }>(
      "SELECT id, slug, api_key_hash FROM public.organizations WHERE api_key_hash = $1 AND is_active",
      [hash],
    );
    const org = rows[0];
    if (!org || !hashesEqual(org.api_key_hash, hash)) throw new UnauthorizedException(DENIED);
    req.agent = { orgId: org.id, slug: org.slug };
    return true;
  }
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly verifier: JwtVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const authorization = req.headers.authorization;
    const match =
      typeof authorization === "string" ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
    if (!match) throw new UnauthorizedException(DENIED);
    try {
      const claims = await this.verifier.verify(match[1] as string);
      req.user = { userId: claims.sub };
      return true;
    } catch (err) {
      if (err instanceof JwtError) throw new UnauthorizedException(DENIED);
      throw err;
    }
  }
}

export const Agent = createParamDecorator((_: unknown, ctx: ExecutionContext): AgentContext => {
  const agent = ctx.switchToHttp().getRequest<AuthedRequest>().agent;
  if (!agent) throw new UnauthorizedException(DENIED);
  return agent;
});

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): UserContext => {
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw new UnauthorizedException(DENIED);
    return user;
  },
);
