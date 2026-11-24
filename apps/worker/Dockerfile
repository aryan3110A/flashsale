# syntax=docker/dockerfile:1
# Build context is the repository root (shared @flashsale/common package + lockfile).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY apps/gateway/package.json apps/gateway/
COPY apps/booking-api/package.json apps/booking-api/
COPY apps/worker/package.json apps/worker/
COPY apps/mock-service/package.json apps/mock-service/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @flashsale/common --workspace @flashsale/worker && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/common packages/common
COPY apps/worker apps/worker
USER node
EXPOSE 9100
CMD ["node", "apps/worker/src/worker.js"]
