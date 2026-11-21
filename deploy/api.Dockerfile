# NEXORA AI · API (Fastify) + carga DEMO opcional al arrancar
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages ./packages
COPY workers ./workers
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --registry=$NPM_REGISTRY --omit=dev --ignore-scripts --no-audit --no-fund
COPY apps/api ./apps/api
COPY scripts ./scripts
COPY data ./data
COPY supabase/seeds ./supabase/seeds
COPY deploy/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
RUN chmod +x /usr/local/bin/api-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD wget -qO- http://127.0.0.1:${API_PORT}/api/health || exit 1
ENTRYPOINT ["api-entrypoint.sh"]
