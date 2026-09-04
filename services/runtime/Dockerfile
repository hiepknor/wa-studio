FROM node:26.8.1-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS build
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/studio/package.json apps/studio/package.json
COPY services/runtime/package.json services/runtime/package.json
COPY packages/runtime-contract/package.json packages/runtime-contract/package.json
RUN npm ci --workspace @wa/runtime --include-workspace-root

COPY services/runtime/tsconfig*.json services/runtime/
COPY services/runtime/src services/runtime/src
COPY services/runtime/scripts services/runtime/scripts
COPY services/runtime/migrations services/runtime/migrations
COPY services/runtime/event-inbox-migrations services/runtime/event-inbox-migrations
RUN npm -w @wa/runtime run build

FROM node:26.8.1-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS runtime
WORKDIR /workspace
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/studio/package.json apps/studio/package.json
COPY services/runtime/package.json services/runtime/package.json
COPY packages/runtime-contract/package.json packages/runtime-contract/package.json
RUN npm ci --omit=dev --workspace @wa/runtime --include-workspace-root \
  && npm cache clean --force

WORKDIR /workspace/services/runtime
COPY --from=build /workspace/services/runtime/dist ./dist
COPY services/runtime/migrations ./migrations
COPY services/runtime/event-inbox-migrations ./event-inbox-migrations
USER node
CMD ["node", "dist/src/entrypoints/api.js"]
