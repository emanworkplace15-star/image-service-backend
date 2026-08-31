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
| POST | `/internal/images/processed` | `x-api-key` | Lambda callback → `PROCESSED` |

Status flow: `PENDING` → `UPLOADED` → `PROCESSED`. The Lambda callback is
terminal and can arrive before `/complete` (S3 events fire immediately); the
service handles that race safely.

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
