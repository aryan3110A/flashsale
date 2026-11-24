# syntax=docker/dockerfile:1
# Build context is the repository root (npm workspaces + lockfile).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY apps/gateway/package.json apps/gateway/
COPY apps/booking-api/package.json apps/booking-api/
COPY apps/worker/package.json apps/worker/
COPY apps/mock-service/package.json apps/mock-service/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @flashsale/web
COPY apps/web apps/web
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time.
ARG NEXT_PUBLIC_GATEWAY_URL=http://localhost:8080
ENV NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @flashsale/web

FROM node:22-alpine AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 LOAD_RESULTS_DIR=/app/load-results
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
RUN mkdir -p /app/load-results && chown -R node:node /app/load-results
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
