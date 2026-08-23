FROM node:24-alpine AS build
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
RUN npm -w @wa/runtime run build

FROM node:24-alpine AS runtime
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
USER node
CMD ["node", "dist/src/entrypoints/api.js"]
