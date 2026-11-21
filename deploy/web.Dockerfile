# NEXORA AI · Web (Nuxt 4 SPA) compilada a estáticos y servida por nginx
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages ./packages
COPY workers ./workers
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --registry=$NPM_REGISTRY --ignore-scripts --no-audit --no-fund
COPY apps/web ./apps/web
# Variables públicas: quedan incrustadas en el sitio estático (nunca poner claves secretas aquí)
ARG NUXT_PUBLIC_SUPABASE_URL
ARG NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NUXT_PUBLIC_API_URL
ENV NUXT_PUBLIC_SUPABASE_URL=$NUXT_PUBLIC_SUPABASE_URL \
    NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    NUXT_PUBLIC_API_URL=$NUXT_PUBLIC_API_URL
RUN cd apps/web && npx nuxt generate

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/.output/public /usr/share/nginx/html
EXPOSE 80
