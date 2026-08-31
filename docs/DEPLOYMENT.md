# Deployment Guide (for DevOps)

This document lists everything that must exist in AWS for the three applications
to run, so it can be translated into Terraform. Nothing here is IaC itself —
it is the contract between the app code and the infrastructure.

## Components

| Component | Repo / folder | Runs as |
|---|---|---|
| Backend API (NestJS + Prisma) | `image-service-backend/` | Docker container on EKS / ECS / EC2 |
| Frontend (Next.js) | `image-service-frontend/` | Docker container on EKS / ECS / EC2 |
| Image processor | `image-processor-lambda/` | Lambda container image |

## 1. S3 bucket

- One bucket (e.g. `image-service-prod`). Two prefixes are used by convention:
  - `uploads/` — original images written directly by browsers via presigned PUT
  - `processed/` — compressed JPEGs written by the Lambda
- **Event notification**: `s3:ObjectCreated:*` on prefix `uploads/` → target the
  Lambda function. (The handler ignores everything outside `uploads/`, so a
  bucket-wide notification is also safe.)
- The bucket stays private. Nothing is public — browsers get presigned URLs.

## 2. Lambda (image-processor-lambda)

- Build the container image from `image-processor-lambda/Dockerfile`
  (`--platform linux/amd64` or arm64 to match the function arch) and push to ECR.
- Runtime: container image, memory ≥ 512 MB (Sharp is memory-hungry), timeout 30 s.
- **No VPC attachment required.** It talks to S3 and to the backend URL only.
- IAM execution role:
  - `s3:GetObject` on `arn:aws:s3:::BUCKET/uploads/*`
  - `s3:PutObject` on `arn:aws:s3:::BUCKET/processed/*`
  - Basic execution (CloudWatch Logs)
- Environment variables:

| Var | Required | Notes |
|---|---|---|
| `BACKEND_URL` | yes | e.g. `https://api.example.com` — must be reachable **from the Lambda** (public ALB/NLB, or internal ALB if the Lambda is in the VPC) |
| `LAMBDA_API_KEY` | yes | Shared secret; must equal the backend's `LAMBDA_API_KEY` |
| `TARGET_BUCKET` | no | Defaults to the source bucket |
| `MAX_WIDTH` | no | Default 2000 |
| `JPEG_QUALITY` | no | Default 80 |

- Retry story: the handler throws on repeated backend-callback failure, so S3
  event notification retries (and CloudWatch alarms on `Errors`) apply.

## 3. RDS PostgreSQL

- Postgres 15+, private subnets, multi-AZ as desired.
- Database name e.g. `imagedb`. Only one schema (`public`) is used.
- **Migrations**: `prisma migrate deploy` runs automatically as part of the
  backend container's command on startup. No separate migration job needed
  (with multiple backend replicas this is racy in theory — Prisma uses an
  advisory lock, so it is safe in practice; or run a one-off migration task).
- The initial migration seeds the admin user `admin@local` / `admin123`
  (bcrypt). **Rotate this password after first login.**
- `DATABASE_URL` should come from Secrets Manager / SSM, injected as an env var.

## 4. Backend (EKS / ECS / EC2)

- Build from `image-service-backend/Dockerfile`, port 3001.
- Environment variables:

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql://user:pass@host:5432/imagedb` |
| `AWS_REGION` | yes | Region of the S3 bucket |
| `S3_BUCKET` | yes | Bucket name from §1 |
| `JWT_SECRET` | yes | ≥ 32 random bytes, e.g. `openssl rand -hex 32` |
| `LAMBDA_API_KEY` | yes | Shared secret; must equal the Lambda's |
| `PRESIGN_EXPIRES` | no | Presigned GET lifetime seconds (default 3600) |
| `CORS_ORIGIN` | no | Comma-separated frontend origins (default `*`) |
| `PORT` | no | Default 3001 |

- **IAM role — no static keys** (this is the whole point of the role-based design):

| Platform | Mechanism |
|---|---|
| EKS | IRSA (`eks:AssumeRoleWithWebIdentity`) or EKS Pod Identity, bound to the backend service account |
| ECS | Task role |
| EC2 | Instance profile |

  The role needs on the bucket `arn:aws:s3:::BUCKET`:
  - `s3:PutObject` (presigned PUT upload)
  - `s3:GetObject` (presigned GET gallery)
  - `s3:HeadObject` (upload-complete verification)

- Networking: egress to RDS (5432) and to S3 (public endpoint, or a VPC
  gateway endpoint if the workload runs in private subnets). Ingress on 3001
  from the load balancer, and from the Lambda if the backend is internal.

## 5. Frontend (EKS / ECS / EC2)

- Build from `image-service-frontend/Dockerfile`, port 3000.
- `NEXT_PUBLIC_API_URL` is **baked in at build time** (Docker `ARG`) — it must
  be the *publicly reachable* backend URL. Rebuild the image to change it.
- No AWS permissions at all — it never talks to AWS directly.

## 6. Secrets summary

| Secret | Used by | Rotation note |
|---|---|---|
| `JWT_SECRET` | backend | Rotating logs everyone out |
| `LAMBDA_API_KEY` | backend + lambda | Change in both places together |
| DB credentials | backend (`DATABASE_URL`) | Standard RDS rotation |
| `admin@local` / `admin123` | seeded by migration | Rotate via SQL (see backend README) |

## 7. Local development (static keys)

AWS-side, local runs use explicit keys — the same code works unchanged because
it relies on the SDK default credential chain:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=eu-west-1
```

Then per repo:

```bash
# backend
cd image-service-backend
docker compose up -d              # local Postgres
cp .env.example .env              # set S3_BUCKET, JWT_SECRET, LAMBDA_API_KEY
npx prisma migrate deploy
npm install && npm run build && npm start

# frontend
cd image-service-frontend
cp .env.example .env.local        # points at http://localhost:3001
npm install && npm run dev

# lambda (unit tests, no AWS needed)
cd image-processor-lambda
npm install && npm test
```

## 8. Alternative considered: Lambda → RDS directly

The Lambda could update the `images` table itself instead of calling the
backend. If you ever prefer that, the extra wiring is:

- Lambda attached to the VPC (private subnets) + security group allowing
  egress 5432 to the RDS security group
- `DATABASE_URL` env var on the Lambda
- NAT gateway or VPC endpoints so the Lambda can still reach S3 from inside
  the VPC
- Prisma (or pg) client + connection reuse inside the handler (watch
  connection limits with concurrent invocations)

The API-key callback in this repo avoids all of the above and keeps the Lambda
stateless — that's why it was chosen.

## 9. End-to-end verification checklist

1. `POST /auth/login` with `admin@local` / `admin123` returns a token.
2. Upload via the frontend; object appears under `uploads/` in S3.
3. Lambda logs show compression (`x -> y bytes, z% saved`); object appears
   under `processed/`.
4. Records page shows the row moving `PENDING → UPLOADED → PROCESSED`.
5. Gallery shows the compressed image via a presigned URL (no AWS creds in
   the browser, bucket stays private).
