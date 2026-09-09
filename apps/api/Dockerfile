# ─── Stage 1: base ────────────────────────────────────────────────────────────
# Shared base with pnpm installed. Pin the pnpm version to match the repo's
# lockfile format (pnpm 10.x).
FROM node:24-alpine AS base
# corepack is not bundled with Node from 26 onward (node:24-alpine ships
# corepack 0.35.0; node:26-alpine ships none), so `corepack enable` fails there
# with "corepack: not found" — exit 127, before anything else runs. npm is still
# bundled on both, so installing pnpm through it works on 24 today and does not
# have to change again when the base image moves to 26. apps/web/Dockerfile
# already does this for the same reason.
RUN npm install -g pnpm@10.30.1
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

# Non-root user for safety. Created BEFORE the copy so ownership can be set by
# COPY --chown rather than a later `chown -R`.
RUN addgroup -S roomer && adduser -S roomer -G roomer

# Copy the self-contained deployment produced above.
# The Prisma client (generated in step 5) is already inside /deploy/node_modules.
#
# --chown is load-bearing, not cosmetic. This was previously a plain COPY
# followed by `RUN chown -R roomer:roomer /app`, and because chown rewrites
# metadata on every file, the whole ~400MB tree landed in a second layer on top
# of the one COPY had just written — the image shipped /app twice. Setting
# ownership during the copy keeps it to a single layer.
COPY --from=build --chown=roomer:roomer /deploy ./

# Create the uploads directory expected by the API. `chown` here is on two
# directories, not a recursive walk of the tree, so it costs a few bytes rather
# than duplicating the whole image (/app itself isn't covered by COPY --chown,
# which only sets ownership on the entries it copies).
RUN mkdir -p uploads && chown roomer:roomer /app uploads

USER roomer

EXPOSE 3001

# Run migrations then start the server. Migrations are idempotent — safe to
# run on every container start.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node seed.js && node dist/index.js"]
