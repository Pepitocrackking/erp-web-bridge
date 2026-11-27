# API NestJS de erp-web-bridge. El contexto de build es la RAÍZ del repo:
#   docker build -f apps/api/Dockerfile -t erp-web-bridge-api .
# Imagen final: solo las dependencias de producción y el JS compilado, sin código fuente, pruebas
# ni herramientas de desarrollo, y corriendo como usuario sin privilegios.
# syntax=docker/dockerfile:1

FROM node:24-slim AS build
RUN npm install -g pnpm@12.14.0
WORKDIR /repo

# 1) Manifiestos y lockfile: esta capa solo se rehace si cambian las dependencias.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared-types/package.json packages/shared-types/
RUN pnpm install --frozen-lockfile --filter @erp-web-bridge/api...

# 2) Código: compila shared-types y la API y extrae lo mínimo para producción.
COPY packages/shared-types packages/shared-types
COPY apps/api apps/api
RUN pnpm --filter @erp-web-bridge/api... build \
 && pnpm --filter @erp-web-bridge/api deploy --prod /out

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app
# Parches de seguridad del sistema operativo: la imagen base puede ir semanas por detrás de Debian
# (el escaneo con Trivy encontró libpam con CVE corregida en el repositorio pero no en la base).
RUN apt-get update  && apt-get upgrade -y --no-install-recommends  && rm -rf /var/lib/apt/lists/*
# La imagen final solo ejecuta `node`: sin npm, npx ni corepack (ni sus dependencias empaquetadas, que
# el escaneo marcó con CVE altas) hay menos superficie de ataque y la imagen pesa menos.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
