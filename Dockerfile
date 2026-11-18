FROM node:24-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js postcss.config.js tailwind.config.js ./
COPY src/ ./src/
COPY server/security.js ./server/security.js
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
RUN test -n "$VITE_SUPABASE_URL" && test -n "$VITE_SUPABASE_ANON_KEY" \
    && node --input-type=module -e 'import { assertPublicSupabaseKey } from "./server/security.js"; assertPublicSupabaseKey(process.env.VITE_SUPABASE_ANON_KEY)' \
    && VITE_AI_MODE=ecs npm run build

FROM node:24-bookworm-slim AS api-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM nginx:stable-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/dist/ /usr/share/nginx/html/

FROM node:24-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=256
COPY --from=api-deps /app/node_modules/ ./node_modules/
COPY package.json ./
COPY server/ ./server/
RUN install -d -o node -g node -m 0700 /var/lib/reader
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
