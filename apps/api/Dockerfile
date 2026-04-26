# ─── Stage 1: base ────────────────────────────────────────────────────────────
# Shared base with pnpm enabled. Pin the pnpm version to match the repo's
# lockfile format (pnpm 10.x).
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
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

# 3. Compile the API and the seed script
RUN pnpm --filter @roomer/api build
RUN pnpm --filter @roomer/api exec tsc -p tsconfig.seed.json

# 4. Create a self-contained deployment directory with only production
#    dependencies (pnpm deploy resolves workspace packages automatically).
RUN pnpm --filter @roomer/api deploy --prod --legacy /deploy

# Copy the compiled output into the deployment directory
RUN cp -r apps/api/dist /deploy/dist
# Copy the compiled seed so it can run inside the production container
RUN cp apps/api/dist-seed/prisma/seed.js /deploy/seed.js

# Copy the Prisma schema and migrations — needed for `prisma migrate deploy`
# on first startup and for the Prisma client to locate the schema at runtime.
RUN cp -r apps/api/prisma /deploy/prisma

# Copy prisma.config.ts — Prisma 7 reads this for the database adapter/URL.
# (pnpm deploy copies source files, but prisma.config.ts sits at package root)
RUN cp apps/api/prisma.config.ts /deploy/prisma.config.ts

# 5. Regenerate the Prisma client inside the deployment directory.
#    pnpm deploy installs packages fresh so the generated client (.prisma/client/)
#    is absent until we run generate here against the schema we just copied.
RUN cd /deploy && node_modules/.bin/prisma generate

# ─── Stage 4: runner ──────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /app

# Copy the self-contained deployment produced above.
# The Prisma client (generated in step 5) is already inside /deploy/node_modules.
COPY --from=build /deploy ./

# Create the uploads directory expected by the API
RUN mkdir -p uploads

# Non-root user for safety
RUN addgroup -S roomer && adduser -S roomer -G roomer
RUN chown -R roomer:roomer /app
USER roomer

EXPOSE 3001

# Run migrations then start the server. Migrations are idempotent — safe to
# run on every container start.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node seed.js && node dist/index.js"]
