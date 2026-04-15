# Roomer

A self-hosted workspace booking platform for managing desk and asset reservations across buildings and floors. Built for teams that want full control over their office space data.

---

## Features

- **Floor plan management** — upload image or PDF floor plans and place bookable assets on a canvas
- **Desk and asset booking** — book desks by date with availability status (available, booked, assigned, queued, restricted)
- **Permanent assignments** — assign desks permanently to users with primary/secondary ownership
- **Zone management** — group assets into colour-coded zones with optional zone conflict rules
- **Queue system** — users can join a waitlist and be automatically promoted when a desk becomes free
- **Bulk import** — import buildings, floors, zones and assets from CSV in one pass
- **Asset registry** — track non-bookable physical inventory (laptops, monitors, etc.) alongside bookable space
- **Role-based access** — super admin, building admin, floor manager, and user roles
- **Enterprise auth** — LDAP, SAML, and OpenID Connect support alongside local accounts
- **Email notifications** — booking confirmations and queue promotions via SMTP

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

## Project Structure

```
roomer/
├── apps/
│   ├── api/          # Fastify REST API
│   │   ├── prisma/   # Schema, migrations, seed
│   │   └── src/
│   │       ├── routes/
│   │       ├── middleware/
│   │       └── lib/
│   └── web/          # React SPA
│       └── src/
│           ├── components/
│           ├── pages/
│           ├── hooks/
│           └── stores/
├── packages/
│   └── shared/       # Shared types and Zod schemas
├── docker-compose.yml
└── turbo.json
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) v20 or later
- [pnpm](https://pnpm.io) v9 or later (`npm install -g pnpm`)
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

### 1. Clone and install dependencies

```bash
git clone <repo-url> roomer
cd roomer
pnpm install
```

### 2. Start infrastructure services

The `docker-compose.yml` starts PostgreSQL 18 and [Mailpit](https://mailpit.axllent.org) (a local SMTP/webmail catcher for development email).

```bash
docker compose up -d
```

| Service | Local URL | Notes |
|---|---|---|
| PostgreSQL | `localhost:5435` | User: `roomer`, Password: `roomer`, DB: `roomer` |
| Mailpit (SMTP) | `localhost:1025` | SMTP relay for outbound email |
| Mailpit (Web UI) | `http://localhost:8025` | View sent emails in browser |

### 3. Configure the API environment

Create `apps/api/.env`:

```env
# Required
DATABASE_URL=postgresql://roomer:roomer@localhost:5435/roomer
SESSION_SECRET=<generate with: openssl rand -hex 32>

# Defaults shown — override as needed
NODE_ENV=development
PORT=3001
CORS_ORIGIN=http://localhost:5173

# Email (matches docker-compose Mailpit defaults)
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
EMAIL_FROM=noreply@roomer.local
APP_URL=http://localhost:5173
```

Generate a session secret:

```bash
openssl rand -hex 32
```

### 4. Run database migrations and seed

```bash
# Apply all migrations
pnpm --filter api db:migrate

# Seed demo data (org, admin user, sample building/floors/desks)
pnpm --filter api db:seed
```

The seed creates:

| Resource | Value |
|---|---|
| Admin email | `admin@roomer.local` |
| Admin password | `admin123` |
| Organisation | Acme Corp |
| Building | Head Office |
| Floors | Ground Floor with 6 sample desks across two zones |

### 5. Start the development servers

```bash
# Start both API and web concurrently via Turborepo
pnpm dev
```

Or start each individually:

```bash
pnpm --filter api dev    # API on http://localhost:3001
pnpm --filter web dev    # Web on http://localhost:5173
```

Open `http://localhost:5173` and log in with `admin@roomer.local` / `admin123`.

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

## API

The REST API runs on port `3001` by default.

- Swagger UI: `http://localhost:3001/docs`
- All routes are prefixed `/api/v1`

### Key endpoints

| Prefix | Description |
|---|---|
| `/api/v1/auth` | Login, logout, session, enterprise SSO |
| `/api/v1/buildings` | Buildings CRUD |
| `/api/v1/floors` | Floors, zones, floor plan upload, availability |
| `/api/v1/assets` | Asset registry, bookable desk management, user assignments |
| `/api/v1/bookings` | Booking lifecycle |
| `/api/v1/import/bulk` | CSV bulk import for buildings/floors/zones/assets |
| `/api/v1/users` | User management |
| `/api/v1/groups` | Group management for role assignments |
| `/api/v1/settings` | Organisation settings, auth provider config |

---

## Configuration Reference

All API environment variables with their defaults:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `SESSION_SECRET` | — | Cookie signing secret, min 32 chars (required) |
| `PORT` | `3001` | API listen port |
| `HOST` | `0.0.0.0` | API bind address |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed frontend origin |
| `COOKIE_SECURE` | `false` in dev, `true` in prod | Require HTTPS for session cookies |
| `TRUST_PROXY` | `false` in dev, `true` in prod | Trust `X-Forwarded-For` headers |
| `ALLOW_BEARER_AUTH` | `true` in dev, `false` in prod | Accept `Authorization: Bearer` tokens |
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

## Docker — Full Stack

The included Dockerfiles build production-ready images for both apps. The `docker-compose.yml` starts all four services together: `postgres`, `mailpit`, `api`, and `web`.

### Images

| Image | Dockerfile | Description |
|---|---|---|
| `roomer-api` | `apps/api/Dockerfile` | Multi-stage Node 22 Alpine build. Runs Prisma migrations then starts the Fastify server. |
| `roomer-web` | `apps/web/Dockerfile` | Multi-stage Vite build served by nginx 1.27. Proxies `/api` to the API service. |

Both Dockerfiles use the monorepo root as the build context so they can access `packages/shared`.

### Run the full stack

Create a `.env` file in the project root:

```env
SESSION_SECRET=<openssl rand -hex 32>
APP_ORIGIN=http://localhost
COOKIE_SECURE=false
WEB_PORT=80
EMAIL_FROM=noreply@roomer.local
```

Then build and start everything:

```bash
docker compose up --build
```

The web app will be available at `http://localhost` (or `WEB_PORT` if overridden).

On first start, the API container automatically runs `prisma migrate deploy` before the server starts, so the database schema is always up to date.

To seed demo data after the first start:

```bash
docker compose exec api npx prisma db seed
```

### Environment variables passed to containers

The `docker-compose.yml` reads the following from the host environment or a root-level `.env` file:

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | — | Required. 32+ character random string. |
| `APP_ORIGIN` | `http://localhost` | Public URL of the web app (used in CORS and email links). |
| `COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS. |
| `WEB_PORT` | `80` | Host port to expose the web container on. |
| `EMAIL_FROM` | `noreply@roomer.local` | Sender address for system emails. |

### Build images individually

```bash
# API image only
docker build -f apps/api/Dockerfile -t roomer-api .

# Web image only
docker build -f apps/web/Dockerfile -t roomer-web .
```

Note: both builds must be run from the **monorepo root** (`.`) so the build context includes `packages/shared`.

---

## Production Deployment

The Docker images are production-ready as-is. Key points for a production environment:

1. Set `COOKIE_SECURE=true` and serve over HTTPS
2. Set `APP_ORIGIN` to your public domain (e.g. `https://roomer.example.com`)
3. Use a managed PostgreSQL instance by overriding `DATABASE_URL` in the API service environment
4. Mount a persistent volume at `/app/uploads` in the API container for floor plan storage (already configured in `docker-compose.yml`)
5. To scale the API horizontally, ensure `FILE_STORAGE_PATH` points to shared network storage rather than a local volume

---

## License

MIT
