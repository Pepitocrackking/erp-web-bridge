# Web Next.js de erp-web-bridge. El contexto de build es la RAÍZ del repo:
#   docker build -f apps/web/Dockerfile -t erp-web-bridge-web \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<proyecto>.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<clave anon> .
#
# Las variables NEXT_PUBLIC_* se incrustan en el JavaScript al compilar: hay una imagen por
# entorno (producción, staging...). Los secretos y la URL de la API se leen en tiempo de ejecución.
# syntax=docker/dockerfile:1

FROM node:24-slim AS build
RUN npm install -g pnpm@12.14.0
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared-types/package.json packages/shared-types/
RUN pnpm install --frozen-lockfile --filter @erp-web-bridge/web...

COPY packages/shared-types packages/shared-types
COPY apps/web apps/web

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_API_URL
# Falla temprano y con un mensaje claro si falta lo imprescindible.
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
 || (echo "Faltan --build-arg NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY" >&2; exit 1)
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @erp-web-bridge/web... build

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3100
WORKDIR /app
# Next "standalone" ya trae solo las dependencias que usa; en un monorepo anida la app en apps/web.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
