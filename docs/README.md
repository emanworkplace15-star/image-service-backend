# Image Upload Service

Three independently deployable apps. Each folder is self-contained and can be
pushed to its own repository.

| Folder | What it is |
|---|---|
| `image-service-backend/` | NestJS API — presigned S3 URLs, Postgres (Prisma), admin JWT auth |
| `image-service-frontend/` | Next.js — public gallery, admin upload + records pages |
| `image-processor-lambda/` | S3-event Lambda (Sharp) — compresses uploads, notifies backend |
| `docs/DEPLOYMENT.md` | Everything a devops engineer needs to provision AWS for this |

## Flow

```
Browser ──POST /images/presign (admin JWT)──► Backend ──► Image row (PENDING) + presigned PUT URL
Browser ──PUT file (presigned)──────────────► S3 uploads/{id}.{ext}
S3 event ──► Lambda (Sharp compress) ──► S3 processed/{id}.jpg
                                            │
Lambda ──POST /internal/images/processed (x-api-key)──► Backend: status=PROCESSED
```

- Gallery is **public** (presigned GET URLs); upload and records pages are
  **admin-only** (JWT).
- The Lambda never touches the database — it reports completion to the backend
  with a shared API key, so it needs no VPC attachment.
- AWS credentials come from the SDK default chain: roles on AWS
  (EKS IRSA / ECS task role / EC2 profile), env vars or `~/.aws/credentials`
  locally.

## Local quickstart

1. Provision (or point at) an S3 bucket + static AWS keys.
2. Follow each folder's README, or see `docs/DEPLOYMENT.md` §7 for the full
   walkthrough including the local Postgres via docker compose.

Default admin login (seeded by the initial migration): `admin@local` /
`admin123` — change it before doing anything real.
