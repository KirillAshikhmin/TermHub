# syntax=docker/dockerfile:1

# ── Стадия сборки: весь workspace ──────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Манифесты отдельно — для кэшируемого npm ci (общий lockfile требует все workspace).
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/relay/package.json packages/relay/package.json

# --ignore-scripts: не собираем нативный node-pty (зависимость агента, relay не нужен).
RUN npm ci --ignore-scripts

COPY . .

# protocol → web (кладёт бандл и в relay/static) → relay; затем срезаем dev-deps.
RUN npm run build -w @termhub/protocol \
 && npm run build -w @termhub/web \
 && npm run build -w @termhub/relay \
 && npm prune --omit=dev --ignore-scripts

# ── Рантайм: только dist relay + dist protocol + prod-deps + статика ────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=9720
# RELAY_TRUST_PROXY=1 — доверять X-Forwarded-For (первый IP) для rate-limit.
# Включать ТОЛЬКО за доверенным TLS-прокси (Caddy/nginx); при прямом доступе оставить
# выключенным, иначе клиент подделает XFF и обойдёт лимит. По умолчанию выключено.
ENV RELAY_TRUST_PROXY=0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/relay/package.json ./packages/relay/package.json
COPY --from=build /app/packages/relay/dist ./packages/relay/dist
COPY --from=build /app/packages/relay/bin ./packages/relay/bin
COPY --from=build /app/packages/relay/static ./packages/relay/static

USER node
EXPOSE 9720

# Healthcheck через встроенный fetch (Node 22) — без лишних утилит в образе.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9720)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/relay/bin/termhub-relay.js"]
