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

## 1a. SQS queue (only for `NOTIFY_MODE=sqs`)

If the Lambda→backend leg runs in queue mode, create a **standard** queue
(FIFO is not needed — ordering is per-image and duplicates are tolerated),
e.g. `image-service-events-<env>`:

- Visibility timeout ≥ 60 s (at least 2× the worst-case consumer handling time)
- Redrive policy to a DLQ recommended (the consumer deletes poison messages,
  but a DLQ still catches infrastructure weirdness)
- Message body (set by the Lambda):
  `{type:'processed'|'failed', originalKey, processedKey?, processedSize?,
  failureReason?, occurredAt}`
- IAM:
  - Lambda execution role → `sqs:SendMessage` on the queue ARN
  - Backend role → `sqs:ReceiveMessage`, `sqs:DeleteMessage`,
    `sqs:GetQueueAttributes` on the queue ARN
- The backend long-polls (`WaitTimeSeconds=20`). SQS is at-least-once, so a
  duplicate message may occur — the DB updates are idempotent, so the worst
  case is a duplicate toast.
- Frontend notification behavior is identical in both modes: whichever path
  applies the DB event also broadcasts it to connected browsers.

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
| `NOTIFY_MODE` | no | `api` (default): POST results to the backend; `sqs`: publish to `SQS_QUEUE_URL` |
| `BACKEND_URL` | api mode | e.g. `https://api.example.com` — must be reachable **from the Lambda** (public ALB/NLB, or internal ALB if the Lambda is in the VPC) |
| `LAMBDA_API_KEY` | api mode | Shared secret; must equal the backend's `LAMBDA_API_KEY` |
| `SQS_QUEUE_URL` | sqs mode only | Queue from §1a |
| `TARGET_BUCKET` | no | Defaults to the source bucket |
| `MAX_WIDTH` | no | Default 2000 |
| `JPEG_QUALITY` | no | Default 80 |

- Retry story: a *processing* failure is reported to the backend
  (`type:'failed'`) and the record is skipped — no S3 retry, no duplicate
  failure notifications. A failure to *report* (network, auth) throws so S3
  event notification retries apply. In sqs mode, SQS itself is the retry
  surface (plus CloudWatch alarms on `Errors`).

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
| `NOTIFY_MODE` | no | `api` (default): the Lambda posts results over HTTP; `sqs`: this service consumes them from `SQS_QUEUE_URL` |
| `SQS_QUEUE_URL` | sqs mode only | Queue from §1a |
| `PRESIGN_EXPIRES` | no | Presigned GET lifetime seconds (default 3600) |
| `CORS_ORIGIN` | no | Comma-separated frontend origins (default `*`). Also covers the Socket.IO gateway — browsers connect a WebSocket for realtime notifications (JWT in the handshake) |
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
  - `s3:DeleteObject` on `uploads/*` and `processed/*` (bulk delete)

  In `NOTIFY_MODE=sqs` it also needs on the queue ARN (§1a):
  - `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`

- Networking: egress to RDS (5432), to S3 (public endpoint, or a VPC
  gateway endpoint if the workload runs in private subnets), and to SQS in
  queue mode. Ingress on 3001 from the load balancer **and from browsers over
  WebSocket** (`/socket.io` path) for the realtime notifications. In `api`
  mode also from the Lambda if the backend is internal.

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

## 9a. Full-pipeline testing against the Floci emulator (local)

The whole `NOTIFY_MODE=sqs` pipeline can run against [Floci](https://floci.io)
(localhost AWS emulator, `../flocki/`), no real AWS account needed. S3
presigned URLs (path+virtual-host via `*.localhost.floci.io`), S3
`ObjectCreated:*` → Lambda notification delivery, and SQS all work there.

1. Emulator + resources (from `../flocki/`):
   ```bash
   floci start --services s3,sqs,lambda
   eval $(floci env)   # then run the aws commands of these docs with --endpoint-url $AWS_ENDPOINT_URL
   aws s3api create-bucket --bucket flocki-image-service
   aws sqs create-queue --queue-name image-service-events
   ```
2. Backend (from `image-service-backend/`) — source `.env`, then override:
   ```bash
   export NOTIFY_MODE=sqs
   export SQS_QUEUE_URL=http://localhost:4566/000000000000/image-service-events
   export S3_BUCKET=flocki-image-service
   export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
   export AWS_ENDPOINT_URL=http://localhost.floci.io:4566
   export AWS_ENDPOINT_URL_S3=http://s3.localhost.floci.io:4566   # virtual-host S3
   npm run build && npm start
   ```
   Watch for `SqsEventConsumerService - Consuming processor events` in the log.
3. Lambda: deploy `src/handler.js` (+ `sharp` and `@img/sharp-linux-<arch>` +
   `@img/sharp-libvips-linux-<arch>` node_modules) as a nodejs20.x zip with env
   `NOTIFY_MODE=sqs`, `SQS_QUEUE_URL=http://localhost.floci.io:4566/.../image-service-events`
   (Floci injects `AWS_ENDPOINT_URL` into the function container itself).
   Then hook the trigger:
   ```bash
   aws lambda create-function --function-name image-processor --runtime nodejs20.x \
     --handler index.handler --role arn:aws:iam::000000000000:role/lambda-role \
     --timeout 30 --memory-size 512 --zip-file fileb://function.zip \
     --environment "Variables={NOTIFY_MODE=sqs,SQS_QUEUE_URL=http://localhost.floci.io:4566/000000000000/image-service-events}"
   aws s3api put-bucket-notification-configuration --bucket flocki-image-service \
     --notification-configuration '{"LambdaFunctionConfigurations":[{"Id":"uploads-to-image-processor","LambdaFunctionArn":"arn:aws:lambda:us-east-1:000000000000:function:image-processor","Events":["s3:ObjectCreated:*"],"Filter":{"Key":{"FilterRules":[{"Name":"prefix","Value":"uploads/"},{"Name":"suffix","Value":".png"}]}}}]}'
   ```
   The `suffix` filter doubles as the loop guard here (in real AWS the handler
   itself skips non-`uploads/` keys).
4. Use the frontend as usual: presigned PUT → object lands in Floci S3 →
   `ObjectCreated` fires the Lambda → SQS → backend consumer → `PROCESSED`
   row + socket toast. Lambda logs: `aws logs get-log-events` on
   `/aws/lambda/image-processor`.

## 9. End-to-end verification checklist

1. `POST /auth/login` with `admin@local` / `admin123` returns a token.
2. Upload via the frontend; object appears under `uploads/` in S3.
3. Lambda logs show compression (`x -> y bytes, z% saved`); object appears
   under `processed/`.
4. Records page shows the row moving `PENDING → UPLOADED → PROCESSED`.
5. Gallery shows the compressed image via a presigned URL (no AWS creds in
   the browser, bucket stays private).
6. While logged in, upload an image and keep the gallery open: a "Image
   processed" toast appears and the badge flips to `PROCESSED` without a
   refresh (Socket.IO event). Upload of a corrupt object should produce an
   "Image failed" toast instead.
