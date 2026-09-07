# Multi-stage build.
#
# Stage 1 compiles TypeScript to JavaScript (needs devDependencies).
# Stage 2 installs production dependencies only.
# Stage 3 is the image we ship: Node.js runtime + node_modules + dist.
#
# The compiler, the TypeScript sources and all devDependencies stay behind, so
# the final image is small and has a smaller attack surface. No secret is ever
# baked in: the Hetzner token arrives at runtime as an environment variable.

# ---------- stage 1: build ----------
FROM node:24-alpine AS build
WORKDIR /app

# Copy manifests first: as long as they do not change, Docker reuses the cached
# "npm ci" layer and rebuilds are fast.
COPY package.json package-lock.json ./
# --ignore-scripts: a compromised package's install hook would otherwise run
# with the build's privileges. Nothing here needs one.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- stage 2: production dependencies ----------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------- stage 3: runtime ----------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

LABEL org.opencontainers.image.title="hetzner-server-controller" \
      org.opencontainers.image.description="Kubernetes operator that manages Hetzner Cloud declaratively" \
      org.opencontainers.image.vendor="Shebang Labs" \
      org.opencontainers.image.documentation="https://github.com/shebang-labs/hetzner-server-controller#readme" \
      org.opencontainers.image.source="https://github.com/shebang-labs/hetzner-server-controller" \
      org.opencontainers.image.licenses="MIT"

# A dedicated unprivileged user. The uid matches the Helm chart's
# podSecurityContext, which also enforces runAsNonRoot at the Kubernetes level.
#
# The base image bundles npm and corepack, which the runtime never calls and
# which carry their own dependency tree — every CVE in that tree would be
# reported against this image for nothing. Remove them.
#
# apk upgrade picks up OS security fixes published after the base image was
# cut; the image is rebuilt on every push, so this stays current.
RUN apk upgrade --no-cache \
    && addgroup -g 65532 -S operator && adduser -u 65532 -S operator -G operator \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER 65532:65532

# The operator serves /healthz, /readyz and /metrics here. Declaring it does not
# publish anything; it documents the port for anyone reading the image.
EXPOSE 8080

# Exec form: node becomes PID 1 and receives SIGTERM directly, which is what the
# graceful shutdown handler in src/main.ts waits for.
CMD ["node", "dist/main.js"]
