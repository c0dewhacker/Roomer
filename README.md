# Roomer

> Self-hosted workspace booking — desks, assets, and floor plans, fully under your control.

[![License: ELv2](https://img.shields.io/badge/license-Elastic%20v2-blue)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-c0dewhacker%2Froomer-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/u/c0dewhacker)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/c0dewhacker/Roomer/docker.yml)

---

## What is Roomer?

Roomer is a self-hosted platform for managing desk and asset reservations across offices, buildings, and floors. Upload floor plans, place bookable assets on a canvas, and let your team book space — without handing your occupancy data to a third-party SaaS.

---

## Features

| | |
|---|---|
| **Floor plan editor** | Upload image, PDF or DXF floor plans and place assets on an interactive canvas |
| **Desk & asset booking** | Book by date with live availability (available, booked, assigned, queued, restricted) |
| **Permanent assignments** | Assign desks to users with primary/secondary ownership |
| **Zone management** | Group assets into colour-coded zones with optional conflict rules |
| **Queue & waitlist** | Users join a waitlist and are automatically promoted when a desk frees up |
| **Bulk CSV import** | Import buildings, floors, zones, and assets in a single pass |
| **Asset registry** | Track non-bookable inventory (laptops, monitors, etc.) alongside bookable space |
| **Role-based access** | Super admin, floor manager, and user roles |
| **Enterprise auth** | LDAP, SAML, and OpenID Connect alongside local accounts |
| **Email notifications** | Booking confirmations and queue promotions via SMTP |

---

## Stack

| Layer | Technology |
|---|---|
| API | [Fastify](https://fastify.dev) + TypeScript |
| Database | PostgreSQL 18 + [Prisma](https://prisma.io) ORM |
| Frontend | React 18 + Vite + Tailwind CSS + shadcn/ui |
| Canvas | Konva (react-konva) |
| Job queue | pg-boss (PostgreSQL-backed) |
| Monorepo | pnpm workspaces + Turborepo |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) v20+
- [pnpm](https://pnpm.io) v9+ — `npm install -g pnpm`
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

### 1. Clone and install

```bash
git clone https://github.com/c0dewhacker/Roomer.git roomer
cd roomer
pnpm install
```

### 2. Start infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL and [Mailpit](https://mailpit.axllent.org) (local SMTP catcher for dev email):

| Service | URL | Notes |
|---|---|---|
| PostgreSQL | `localhost:5435` | User/pass/db: `roomer` |
| Mailpit SMTP | `localhost:1025` | Dev email relay |
| Mailpit Web | `http://localhost:8025` | View outbound email |

### 3. Configure the API

Create `apps/api/.env`:

```env
# Required
DATABASE_URL=postgresql://roomer:roomer@localhost:5435/roomer
SESSION_SECRET=<openssl rand -hex 32>

# Defaults — override as needed
NODE_ENV=development
PORT=3001
CORS_ORIGIN=http://localhost:5173

# Email (matches Mailpit defaults above)
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
EMAIL_FROM=noreply@roomer.local
APP_URL=http://localhost:5173
```

### 4. Migrate and seed

```bash
pnpm --filter api db:migrate   # apply migrations
pnpm --filter api db:seed      # seed demo data
```

The seed creates:

| Resource | Value |
|---|---|
| Admin login | `admin@roomer.local` / `admin123` |
| Organisation | Acme Corp |
| Building | Head Office |
| Floors | Ground Floor — 6 sample desks across two zones |

### 5. Start dev servers

```bash
pnpm dev                      # both apps via Turborepo
# or individually:
pnpm --filter api dev          # API  → http://localhost:3001
pnpm --filter web dev          # Web  → http://localhost:5173
```

Open `http://localhost:5173` and sign in with `admin@roomer.local` / `admin123`.

---

## Docker

Two compose files are provided:

| File | Purpose |
|---|---|
| `docker-compose.yml` | Pull pre-built images from Docker Hub — fastest way to run |
| `docker-compose.build.yaml` | Build images locally from source |

### Run with pre-built images (recommended)

Create a `.env` in the project root:

```env
SESSION_SECRET=<openssl rand -hex 32>
APP_ORIGIN=http://localhost
COOKIE_SECURE=false
WEB_PORT=80
EMAIL_FROM=noreply@roomer.local
```

Then start everything:

```bash
docker compose up -d
```

The web app will be at `http://localhost` (or `WEB_PORT` if changed).

The API container automatically runs `prisma migrate deploy` on startup, so the database is always up to date. To seed demo data after first start:

```bash
docker compose exec api npx prisma db seed
```

### Build from source

```bash
docker compose -f docker-compose.build.yaml up --build
```

### Images

| Image | Description |
|---|---|
| [`c0dewhacker/roomer-api`](https://hub.docker.com/r/c0dewhacker/roomer-api) | Multi-stage Node 22 Alpine. Runs migrations then starts Fastify. |
| [`c0dewhacker/roomer-web`](https://hub.docker.com/r/c0dewhacker/roomer-web) | Multi-stage Vite build served by nginx 1.27. Proxies `/api` to the API. |

Both images are built from the monorepo root so they can access `packages/shared`.

### Docker Compose environment variables

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | — | **Required.** 32+ character random string. |
| `APP_ORIGIN` | `http://localhost` | Public URL used in CORS and email links. |
| `COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS. |
| `WEB_PORT` | `80` | Host port for the web container. |
| `EMAIL_FROM` | `noreply@roomer.local` | Sender address for system emails. |
| `SEED_DEMO_DATA` | `false` | Set to `true` to seed demo buildings and a test user on first start. |

---

## Production Deployment

The Docker images are production-ready as-is. Key checklist:

- Set `COOKIE_SECURE=true` and serve over HTTPS
- Set `APP_ORIGIN` to your public domain (e.g. `https://roomer.example.com`)
- Use a managed PostgreSQL instance by overriding `DATABASE_URL` in the API environment
- Mount a persistent volume at `/app/uploads` for floor plan storage (already in `docker-compose.yml`)
- For horizontal API scaling, point `FILE_STORAGE_PATH` at shared network storage rather than a local volume

---

## API Reference

The REST API runs on port `3001` by default.

- **Swagger UI:** `http://localhost:3001/docs` (enabled in development; set `SWAGGER_ENABLED=true` to enable in production)
- All routes are prefixed `/api/v1`

| Prefix | Description |
|---|---|
| `/api/v1/auth` | Login, logout, session, enterprise SSO |
| `/api/v1/buildings` | Buildings CRUD |
| `/api/v1/floors` | Floors, zones, floor plan upload, availability |
| `/api/v1/assets` | Asset registry, bookable desks, user assignments |
| `/api/v1/bookings` | Booking lifecycle |
| `/api/v1/queue` | Waitlist management |
| `/api/v1/import/bulk` | CSV bulk import |
| `/api/v1/users` | User management |
| `/api/v1/groups` | Group management |
| `/api/v1/settings` | Organisation settings, auth provider config |

---

## Configuration Reference

All API environment variables:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `SESSION_SECRET` | — | Cookie signing secret, min 32 chars (required) |
| `PORT` | `3001` | API listen port |
| `HOST` | `0.0.0.0` | API bind address |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed frontend origin |
| `COOKIE_SECURE` | `false` in dev | Require HTTPS for session cookies |
| `TRUST_PROXY` | `false` in dev | Trust `X-Forwarded-For` headers |
| `ALLOW_BEARER_AUTH` | `true` in dev | Accept `Authorization: Bearer` tokens |
| `SWAGGER_ENABLED` | `true` in dev | Expose Swagger UI at `/docs` |
| `FILE_STORAGE_PATH` | `./uploads` | Directory for floor plan images |
| `MAX_FILE_SIZE_MB` | `20` | Maximum upload size |
| `SMTP_HOST` | `localhost` | Outbound email relay host |
| `SMTP_PORT` | `1025` | Outbound email relay port |
| `SMTP_SECURE` | `false` | Use TLS for SMTP |
| `SMTP_USER` | — | SMTP username (if required) |
| `SMTP_PASS` | — | SMTP password (if required) |
| `EMAIL_FROM` | `noreply@roomer.local` | Sender address for system emails |
| `APP_URL` | `http://localhost:5173` | Public URL used in email links |

---

## Roles

| Role | Scope | Permissions |
|---|---|---|
| `SUPER_ADMIN` | Global | Full access to all resources and settings |
| `FLOOR_MANAGER` | Per floor | Manage assets and bookings on assigned floors |
| `USER` | Global | Book available assets, manage own bookings |

---

## Available Scripts

Run from the monorepo root:

| Command | Description |
|---|---|
| `pnpm dev` | Start all apps in development mode |
| `pnpm build` | Build all apps for production |
| `pnpm lint` | Lint all packages |
| `pnpm --filter api db:migrate` | Run pending Prisma migrations |
| `pnpm --filter api db:seed` | Seed demo data |
| `pnpm --filter api db:studio` | Open Prisma Studio (database browser) |

---

## Project Structure

```
roomer/
├── apps/
│   ├── api/              # Fastify REST API
│   │   ├── prisma/       # Schema, migrations, seed
│   │   └── src/
│   │       ├── routes/
│   │       ├── middleware/
│   │       └── lib/
│   └── web/              # React SPA
│       └── src/
│           ├── components/
│           ├── pages/
│           ├── hooks/
│           └── stores/
├── packages/
│   └── shared/           # Shared types and Zod schemas
├── docker-compose.yml        # Pull pre-built images
├── docker-compose.build.yaml # Build from source
└── turbo.json
```

---

## License

Roomer is licensed under the [Elastic License 2.0](LICENSE).

**In short:** you can use, modify, and self-host Roomer freely — including for commercial internal use. You may **not** provide Roomer as a managed hosted service to third parties (i.e. you cannot run a Roomer-as-a-Service business).

See the [LICENSE](LICENSE) file for the full terms.
