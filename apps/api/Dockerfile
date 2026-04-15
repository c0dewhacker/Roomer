# ─── Stage 1: base ────────────────────────────────────────────────────────────
# Shared base with pnpm enabled. Pin the pnpm version to match the repo's
# lockfile format (pnpm 10.x).
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /repo

# ─── Stage 2: install ─────────────────────────────────────────────────────────
# Copy only the files that affect dependency resolution so Docker can cache this
# layer independently of source changes.
FROM base AS install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Install all workspace dependencies (dev included — needed for the build stage).
RUN pnpm install --frozen-lockfile

# ─── Stage 3: build ───────────────────────────────────────────────────────────
FROM base AS build
COPY --from=install /repo/node_modules ./node_modules
COPY --from=install /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=install /repo/apps/api/node_modules ./apps/api/node_modules

# Copy source
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# 1. Build the shared package (API depends on it at compile time)
RUN pnpm --filter @roomer/shared build

# 2. Generate the Prisma client (must happen before TypeScript compilation so
#    the generated types are available)
RUN pnpm --filter @roomer/api exec prisma generate

# 3. Compile the API
RUN pnpm --filter @roomer/api build

# 4. Create a self-contained deployment directory with only production
#    dependencies (pnpm deploy resolves workspace packages automatically).
RUN pnpm --filter @roomer/api deploy --prod /deploy

# Copy the compiled output into the deployment directory
RUN cp -r apps/api/dist /deploy/dist

# Copy the Prisma schema and migrations — needed for `prisma migrate deploy`
# on first startup and for the Prisma client to locate the schema at runtime.
RUN cp -r apps/api/prisma /deploy/prisma

# ─── Stage 4: runner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

# Install openssl for Prisma (required by the query engine binary)
RUN apk add --no-cache openssl

WORKDIR /app

# Copy the self-contained deployment produced above
COPY --from=build /deploy ./

# Re-generate Prisma client inside the final image so the binary matches the
# Alpine libc. The schema is already present at ./prisma/schema.prisma.
RUN npx prisma generate

# Create the uploads directory expected by the API
RUN mkdir -p uploads

# Non-root user for safety
RUN addgroup -S roomer && adduser -S roomer -G roomer
RUN chown -R roomer:roomer /app
USER roomer

EXPOSE 3001

# Run migrations then start the server. Migrations are idempotent — safe to
# run on every container start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
