# JIDA Backend

REST API for the **Journal of Inter-Discourse Academia (JIDA)** digital publishing platform, implemented per the Software Requirements Specification using **Node.js**, **TypeScript**, **Express**, **Prisma**, and **PostgreSQL** (the SRS references Spring Boot; this project delivers the same capabilities on the Node stack).

## Prerequisites

- Node.js 20+
- PostgreSQL 14+

## Setup

1. Copy environment variables and adjust values (especially `JWT_SECRET`, `DATABASE_URL`):

   ```bash
   cp .env.example .env
   ```

2. Install dependencies and apply the database schema:

   ```bash
   npm install
   npx prisma migrate deploy
   ```

   For local development you can use `npx prisma migrate dev` instead of `deploy`.

3. Start the server:

   ```bash
   npm run dev
   ```

   The API listens on `PORT` (default **4000**). Health check: `GET /health`.

## Security (SRS alignment)

- Passwords are hashed with **bcrypt** (not JWT; JWT is used only for access tokens, as is standard practice).
- **JWT** access tokens expire after **15 minutes** by default (`JWT_ACCESS_EXPIRES_MIN` in `.env`).
- **Role-based access** is enforced on routes (`AUTHOR`, `REVIEWER`, `EDITOR`).

## Email (CI-01)

If `SMTP_*` variables are unset, notification bodies are **logged to the console** so you can develop without mail. Configure SMTP for production (TLS as required by the SRS).

## Main API surface

| Area | Method | Path | Notes |
|------|--------|------|--------|
| Auth | POST | `/api/auth/register` | Body: `email`, `password`, `role` (`AUTHOR` \| `REVIEWER` \| `EDITOR`), optional profile fields |
| Auth | POST | `/api/auth/login` | Returns `accessToken`, `expiresInMinutes` |
| Auth | POST | `/api/auth/forgot-password` | Sends reset token to email |
| Auth | POST | `/api/auth/reset-password` | Body: `token`, `newPassword` |
| Profile | GET/PATCH | `/api/me` | Bearer token required |
| Settings | GET | `/api/settings/submission` | Public: submission deadline / open flag (FR-A12) |
| Manuscripts | POST | `/api/manuscripts` | Author: multipart `file` (PDF/DOCX) + `title`, `abstract`, `keywords`, `references` |
| Manuscripts | GET | `/api/manuscripts` | Author list; `?q=` search (FR-A11) |
| Manuscripts | GET | `/api/manuscripts/:id` | Author detail |
| Manuscripts | POST | `/api/manuscripts/:id/revisions` | Author: new file when status is `REVISION_REQUIRED` (FR-A7) |
| Manuscripts | GET | `/api/manuscripts/:id/files/:fileId/download` | Author download |
| Manuscripts | GET | `/api/manuscripts/published/:slug/download` | Author download of published file (FR-A8) |
| Reviewer | GET | `/api/reviewer/assignments` | Assigned manuscripts + deadlines (FR-R2, FR-R10) |
| Reviewer | GET | `/api/reviewer/assignments/:id/download` | Manuscript file (FR-R3) |
| Reviewer | PATCH | `/api/reviewer/assignments/:id/progress` | Body: `progress` (`NOT_STARTED` … `FINISHED_REVIEW`) (FR-R9) |
| Reviewer | POST | `/api/reviewer/assignments/:id/review` | Body: `commentsToAuthor`, `commentsToEditor`, `recommendation` (FR-R4, FR-R5) |
| Reviewer | GET | `/api/reviewer/history` | Past reviews (FR-R7) |
| Editor | GET | `/api/editor/submissions` | Optional `?status=` |
| Editor | GET | `/api/editor/manuscripts/:id` | Full manuscript + assignments + reviews |
| Editor | GET | `/api/editor/manuscripts/:id/download` | Latest manuscript file |
| Editor | POST | `/api/editor/manuscripts/:id/assign-reviewers` | Body: `{ "assignments": [{ "reviewerId", "deadline" }] }` (FR-E3, FR-E4) |
| Editor | POST | `/api/editor/manuscripts/:id/decision` | Body: `decision` (`ACCEPT` \| `REJECT` \| `REQUEST_REVISION`) (FR-E6) |
| Editor | POST | `/api/editor/issues` | Create journal issue (FR-E8) |
| Editor | POST | `/api/editor/issues/:issueId/publish` | Body: `manuscriptId` — publishes accepted work (FR-E8) |
| Editor | PATCH | `/api/editor/publications/:id/scholar` | Body: `scholarReady` — flag for Google Scholar workflow (FR-E12) |
| Editor | PATCH | `/api/editor/settings` | Body: `submissionDeadline`, `openForSubmissions` |
| Public | GET | `/api/public/issues` | Browse issues |
| Public | GET | `/api/public/articles` | `?q=` text search, `?keyword=` exact keyword match on metadata |
| Public | GET | `/api/public/articles/:slug` | Published article metadata |
| Public | GET | `/api/public/articles/:slug/download` | Public file download |

All authenticated routes expect: `Authorization: Bearer <accessToken>`.

## Operational notes (SRS gaps filled here)

- **DB-02 full-text search**: listing uses PostgreSQL `contains` / array `has` filters. For production-scale full-text, add `tsvector` columns and raw SQL or Prisma extensions.
- **DB-03 / RM-01 backups**, **RM-02 redundancy**: configure at the infrastructure layer (managed Postgres, cron `pg_dump`, etc.).
- **FR-R6 approaching-deadline emails**: not scheduled in-process; add a cron worker or external scheduler calling a future `/internal/review-reminders` endpoint.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | `tsx watch` development server |
| `npm run build` | Generate Prisma client and compile to `dist/` |
| `npm start` | Run compiled server (Render start command) |
| `npm run render:release` | Run migrations on deploy (Render pre-deploy command) |
| `npm run db:migrate` | `prisma migrate dev` |
| `npm run db:push` | `prisma db push` (prototyping) |

## Deploy on Render

This repo includes a [`render.yaml`](render.yaml) blueprint that provisions:

- **PostgreSQL** (`jida-db`) — `DATABASE_URL` linked automatically
- **Web service** (`jida-api`) — Node 22 (via `.node-version`), build, migrate, and health check

### Option A — Blueprint (recommended)

1. Push this repo to GitHub/GitLab.
2. In [Render](https://render.com): **New → Blueprint** → connect the repo.
3. Review the services created from `render.yaml` and apply.
4. In the **jida-api** service → **Environment**, set:
   - `CORS_ORIGIN` — your frontend origin, e.g. `https://your-frontend.onrender.com`
   - `SMTP_*` — production mail (optional; logs to console if unset)
5. Open `https://<jida-api>.onrender.com/health` — should return `{ "ok": true }`.

`JWT_SECRET` is auto-generated by the blueprint. `PORT` is injected by Render; do not set it manually.

### Option B — Manual web service

| Setting | Value |
|---------|--------|
| Runtime | Node |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm start` |
| Pre-Deploy Command | `npm run render:release` |
| Health Check Path | `/health` |

Link a Render Postgres instance and set `DATABASE_URL`, `JWT_SECRET` (≥16 chars), `NODE_ENV=production`, `UPLOAD_DIR=./uploads`, and `CORS_ORIGIN`.

### Environment variables on Render

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | Yes | From linked Postgres (includes SSL) |
| `JWT_SECRET` | Yes | Auto-generated in blueprint, or set manually |
| `NODE_ENV` | Yes | `production` |
| `CORS_ORIGIN` | Yes | Frontend URL for browser requests |
| `UPLOAD_DIR` | Yes | `./uploads` (free) or `/var/data/uploads` with a Render Disk |
| `JWT_ACCESS_EXPIRES_MIN` | No | Default `15` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | No | Production email |
| `PORT` | No | Injected by Render automatically |

### Persistent manuscript uploads

On the **free** web tier, uploaded files are **ephemeral** (lost on redeploy). For production:

1. Upgrade **jida-api** to **Starter** or higher.
2. In `render.yaml`, uncomment the `disk` block and set `UPLOAD_DIR=/var/data/uploads`.
3. Redeploy via Blueprint or add a 1 GB disk in the Render Dashboard (`mountPath: /var/data/uploads`).

Render Postgres on the free tier also expires after 90 days of inactivity; use a paid DB plan for production.

### Prisma version

This project uses **Prisma 6.19.3** (pinned in `package.json`). Do **not** run `npx prisma@latest` or upgrade to Prisma 7 without migrating — Prisma 7 removes `url` from `schema.prisma` and requires `prisma.config.ts`, driver adapters, and Node **20.19+**.
