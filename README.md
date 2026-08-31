# Image Service Backend

NestJS API that issues presigned S3 upload/download URLs, tracks every image
in PostgreSQL (Prisma), and authenticates an admin user with JWT.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/login` | public | `{email, password}` → `{accessToken}` |
| POST | `/images/presign` | admin JWT | `{contentType}` → `{id, key, uploadUrl}` |
| POST | `/images/:id/complete` | admin JWT | verify upload landed in S3 (HEAD) → `UPLOADED` |
| GET | `/images/gallery?page&limit` | public | presigned GET URLs, paginated |
| GET | `/images?page&limit` | admin JWT | raw DB records, paginated |
| DELETE | `/images` | admin JWT | `{ids: [uuid…]}` — deletes rows **and** their S3 objects (≤100 per call) |
| POST | `/internal/images/events` | `x-api-key` | Lambda callback → `PROCESSED` / `FAILED` |

Status flow: `PENDING` → `UPLOADED` → `PROCESSED` or `FAILED`. The Lambda
callback is terminal and can arrive before `/complete` (S3 events fire
immediately); the service handles that race safely and never downgrades
`PROCESSED` to `FAILED` (or `UPLOADED`).

## Realtime notifications

The backend runs a Socket.IO gateway (path `/socket.io`). Browsers connect
with the admin JWT in the handshake (`io(API_URL, { auth: { token } })`) —
unauthenticated connections are disconnected immediately, so logged-out
gallery visitors don't get live updates (fetch still works).

Two broadcast events, emitted whenever a processor event is applied:

- `image:processed` → `{ id, originalKey, processedKey, processedSize, url, occurredAt }` (`url` is a freshly presigned GET)
- `image:failed` → `{ id, originalKey, failureReason, occurredAt }`

The Lambda's result reaches these broadcasts by two interchangeable legs,
selected with `NOTIFY_MODE` on both sides:

- `api` (default): Lambda `POST`s the event to `/internal/images/events` with the shared `x-api-key`.
- `sqs`: Lambda publishes the event to `SQS_QUEUE_URL`; a backend consumer
  long-polls the queue (20 s) and applies + broadcasts the same events.
  Poison messages are deleted; unknown keys are skipped; other errors remain
  in the queue for redelivery (at-least-once — the DB updates are idempotent and
  may cause an occasional duplicate toast).

## Setup

```bash
cp .env.example .env          # fill in S3_BUCKET, AWS_REGION, JWT_SECRET, LAMBDA_API_KEY
docker compose up -d          # local Postgres on :5432
npm install
npx prisma migrate deploy     # creates tables + seeds admin user
npm run build && npm start    # listens on :3001
```

The initial migration seeds `admin@local` / `admin123`. Rotate it:

```sql
-- node -e "require('bcrypt').hash('<new-password>', 10).then(console.log)"
UPDATE users SET password_hash = '<new-hash>' WHERE email = 'admin@local';
```

## Migrations

- `prisma/migrations/000_init/` — initial schema (users, images) + admin seed.
  Hand-written; applied with `prisma migrate deploy` (runs automatically in
  the Docker container on startup).
- `20260831142908_add_failure_reason/` — adds `images.failure_reason` for the
  Lambda failure notifications. Generated with `prisma migrate dev`.
- Schema changes: edit `prisma/schema.prisma`, then
  `npx prisma migrate dev --name <change>` against a dev database and commit
  the generated migration.

## AWS credentials

The S3 client is constructed with **no credentials** on purpose — the AWS SDK
default chain resolves them: EKS IRSA / Pod Identity, ECS task role, EC2
instance profile, or env vars (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`)
for local development.

## Docker

```bash
docker build -t image-service-backend .
# container runs: prisma migrate deploy && node dist/main.js
```

See the root `docs/DEPLOYMENT.md` for the full AWS resource contract
(bucket, event notification, IAM policies, RDS, secrets).
