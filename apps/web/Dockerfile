# ─── Stage 1: base ────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /repo

# ─── Stage 2: install ─────────────────────────────────────────────────────────
FROM base AS install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

# ─── Stage 3: build ───────────────────────────────────────────────────────────
FROM base AS build

# Build-time args injected by the Docker workflow (e.g. from docker/metadata-action)
ARG VITE_APP_VERSION=dev
ARG VITE_APP_REPO_URL=

# Expose as env vars so Vite picks them up during the build
ENV VITE_APP_VERSION=$VITE_APP_VERSION
ENV VITE_APP_REPO_URL=$VITE_APP_REPO_URL

COPY --from=install /repo/node_modules ./node_modules
COPY --from=install /repo/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=install /repo/apps/web/node_modules ./apps/web/node_modules

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

# Build shared package first (web imports types from @roomer/shared)
RUN pnpm --filter @roomer/shared build

# Build the React SPA. Vite outputs to apps/web/dist.
RUN pnpm --filter @roomer/web build

# ─── Stage 4: runner ──────────────────────────────────────────────────────────
# Use nginx to serve the static bundle and proxy /api to the API service.
FROM nginx:1.27-alpine AS runner

# Install envsubst (part of gettext) to substitute ${API_URL} in the nginx config
RUN apk add --no-cache gettext

# nginx's default mime.types predates .mjs — add it to the javascript entry
RUN sed -i '/application\/javascript/s/js;/js mjs;/' /etc/nginx/mime.types

# Copy the built SPA
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html

# Copy the nginx template. The entrypoint substitutes ${API_URL} at runtime
# and writes the final config before nginx starts.
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template

# Remove the default nginx config
RUN rm /etc/nginx/conf.d/default.conf

EXPOSE 80

# Substitute environment variables in the nginx template, then start nginx.
# API_URL defaults to http://api:3001 (the docker-compose service name).
ENV API_URL=http://api:3001
CMD ["/bin/sh", "-c", \
    "envsubst '${API_URL}' < /etc/nginx/templates/default.conf.template \
     > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
