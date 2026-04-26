### Build stage ##############################################################
FROM node:20-alpine AS builder

WORKDIR /app

# better-sqlite3 needs a C++ toolchain to compile its native binding.
# python3 is required by node-gyp, the build orchestrator.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip dev deps so the prod node_modules we copy below is small.
RUN npm prune --omit=dev

### Runtime stage ############################################################
FROM node:20-alpine AS runtime

# docker-cli + the compose v2 plugin so the daemon can shell out to
# `docker compose` against the host's mounted /var/run/docker.sock.
# tini gives us proper signal forwarding on SIGINT/SIGTERM.
RUN apk add --no-cache docker-cli docker-cli-compose tini

ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY README.md CHANGELOG.md LICENSE ./

# Persistent state mount: the SQLite file lives here.
VOLUME ["/var/lib/bumpsight"]
# Approve / deny links + healthcheck endpoint.
EXPOSE 9100

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/dist/cli.js"]
CMD ["daemon"]
