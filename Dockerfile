# syntax=docker/dockerfile:1
FROM oven/bun:1

WORKDIR /app

# Copy manifests first so layer cache is valid when sources change
COPY package.json bun.lock* ./
COPY api/package.json ./api/
COPY sdk/package.json  ./sdk/

RUN bun install --frozen-lockfile

# Copy source
COPY tsconfig.json ./
COPY api/  ./api/
COPY sdk/  ./sdk/

EXPOSE 3000

# Migrations run via fly.toml [deploy] release_command before new instances start.
# Here we just boot the API.
CMD ["bun", "run", "api/src/index.ts"]
