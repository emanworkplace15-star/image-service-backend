# Queue-Mode Configuration Tasks

Simple step-by-step task list for switching the Lambda → backend leg from the
default direct-API callback (`NOTIFY_MODE=api`) to the SQS queue
(`NOTIFY_MODE=sqs`). In both modes the frontend behaves identically — the
backend broadcasts the same Socket.IO events either way.

Full detail for each setting lives in `DEPLOYMENT.md` (§1a, §2, §4, §9a).

---

## 1. Create the queue

- [ ] Create a **standard SQS queue** (not FIFO), e.g. `image-service-events-<env>`
- [ ] Visibility timeout ≥ 60 s (at least 2× worst-case processing time)
- [ ] Add a **redrive policy** pointing at a DLQ (e.g.
      `image-service-events-dlq-<env>`, max receive count 5)
- [ ] Note both queue URLs (needed for backend + Lambda env) and the queue ARN
      (needed for the IAM policies)

## 2. IAM (no static keys — roles only)

- [ ] Lambda **execution role**: add `sqs:SendMessage` on the queue ARN
      (keep the existing `s3:GetObject` on `uploads/*` and `s3:PutObject` on
      `processed/*`)
- [ ] Backend **role** (IRSA / ECS task role / instance profile): add
      `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on
      the queue ARN
- [ ] Keep the DLQ policy simple: only the redrive needs access — no extra
      statements required

## 3. Configure the Lambda

- [ ] Add env var `NOTIFY_MODE=sqs`
- [ ] Add env var `SQS_QUEUE_URL=<queue url from step 1>`
- [ ] `BACKEND_URL` / `LAMBDA_API_KEY` can stay (harmless) or be removed —
      they are unused in sqs mode
- [ ] Keep the S3 event notification on `uploads/` unchanged — the trigger
      side does not change at all

## 4. Configure the backend

- [ ] Add env var `NOTIFY_MODE=sqs`
- [ ] Add env var `SQS_QUEUE_URL=<queue url from step 1>`
- [ ] `LAMBDA_API_KEY` can stay (harmless) or be removed — the `/internal/images/events`
      endpoint is unused in sqs mode
- [ ] `CORS_ORIGIN` unchanged — it only affects the frontend (HTTP + Socket.IO)
- [ ] Networking: the backend now also needs **egress to SQS** (public
      endpoint, or a VPC interface endpoint if running in private subnets)
- [ ] Restart the backend and confirm the log line
      `SqsEventConsumerService - Consuming processor events from SQS <url>`

## 5. Deploy order

- [ ] **Backend first** (the consumer just starts polling an empty queue)
- [ ] **Lambda second** (starts publishing to the queue)
- [ ] Frontend: no changes, no redeploy needed in either mode

## 6. Verify

- [ ] Upload an image from the frontend
- [ ] SQS console (or `aws sqs get-queue-attributes
      --attribute-names ApproximateNumberOfMessages`) momentarily shows the
      message, then drains to 0
- [ ] DB row flips `PENDING → UPLOADED → PROCESSED`
- [ ] Browser shows the toast + badge flip live (Socket.IO, unchanged)
- [ ] Upload a corrupt object → row becomes `FAILED` + failure toast (the
      failure path works through the queue too)
- [ ] DLQ check: DLQ depth is 0 (poison messages are deleted by the consumer;
      anything in the DLQ means real trouble)
- [ ] Re-run this checklist after any region/queue URL change — the URL is
      baked into two services' env

## Rollback (back to `NOTIFY_MODE=api`)

- [ ] Set `NOTIFY_MODE=api` + `BACKEND_URL` + `LAMBDA_API_KEY` on the Lambda
- [ ] Set `NOTIFY_MODE=api` on the backend (the SQS consumer simply never
      starts) and redeploy backend first, then Lambda
- [ ] Keep the queue around until the rollback is verified — in-flight
      messages would otherwise be lost