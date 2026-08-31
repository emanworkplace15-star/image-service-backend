# DevOps Tasks

Work items for the image-service project. Each repo is independent:

| Repo | GitHub |
|---|---|
| image-service-backend | `zeeemughal/image-service-backend` |
| image-service-frontend | `zeeemughal/image-service-frontend` |
| image-processor-lambda | `zeeemughal/image-processor-lambda` |

**Hard rule for all tasks:** no static AWS access key / secret key for any
service, anywhere. Every workload (GitHub Actions, containers, Lambda) gets
AWS access exclusively through IAM roles — the app code already relies on the
SDK default credential chain, so this is purely an infrastructure task.

---

## Task 1 — Fork repos + GitHub Actions CI/CD (OIDC, no static keys)

Every push to `main` builds and pushes the Docker image to ECR; the Lambda
repo also deploys to the Lambda function. GitHub authenticates to AWS via
GitHub OIDC and an IAM role — no static access key/secret key secrets.

### 1.1 Fork the repos

- [ ] Fork all three repos
- [ ] Clone the forks and confirm the default branch

### 1.2 ECR

- [ ] Create ECR repository for the backend image
- [ ] Create ECR repository for the frontend image
- [ ] Create ECR repository for the lambda image
- [ ] Decide and document the image tagging scheme (sha / branch / latest)

### 1.3 GitHub OIDC (single setup for the whole GitHub org/account)

- [ ] Register the GitHub OIDC identity provider in IAM (once, account-level —
      not per repo)
- [ ] Create **one** IAM role for GitHub Actions (shared, not per repo) with a
      trust policy scoped to the GitHub org/account
- [ ] Attach least-privilege permissions to the role:
      ECR push on the three repositories + lambda function code update
- [ ] Verify a workflow from an unauthorized repo is denied by the trust policy

### 1.4 GitHub Actions workflows

- [ ] Backend repo: workflow that builds the image and pushes to ECR
- [ ] Frontend repo: workflow that builds the image (with the backend public
      URL baked in as a build arg) and pushes to ECR
- [ ] Lambda repo: workflow that builds for the correct architecture, pushes
      to ECR, and updates the Lambda function code

### 1.5 Verification

- [ ] All three workflows run green on push to `main`
- [ ] Images visible in ECR with the expected tags
- [ ] Lambda function running the newly pushed image
- [ ] No AWS access key/secret stored in any repo secrets
- [ ] Document how the workflow obtains AWS credentials (which role, how the
      trust is scoped)

---

## Task 2 — VPC "image" + RDS + compute deployment

Deploy the app on AWS: a VPC named `image` containing RDS Postgres and the
application containers. **Choose the compute platform: EC2, EKS, or ECS** —
document the choice and the reasoning (cost, effort, learning value). The
tasks below are common to all three; the platform-specific items are listed
per option.

### 2.1 VPC and networking (all platforms)

- [ ] Create VPC named `image`
- [ ] Create subnets across two AZs (public + private)
- [ ] Set up internet access (IGW) and private-subnet egress (NAT or S3
      gateway endpoint — decide and document the choice)
- [ ] Create security groups with least-privilege ingress rules (load
      balancer, app, database)

### 2.2 RDS Postgres (all platforms)

- [ ] Create the DB subnet group (private subnets)
- [ ] Provision a Postgres instance sized for dev
- [ ] Store master credentials in Secrets Manager (not plaintext)
- [ ] Database name and connectivity verified from the app subnet only

### 2.3 Compute — pick ONE and complete its tasks

#### Option A — EC2

- [ ] Provision an instance in a private subnet (Amazon Linux 2023)
- [ ] Create an **instance profile role**: S3 read/write on the image bucket,
      Secrets Manager read for the app secrets, SSM access
- [ ] Install Docker on the instance
- [ ] Run the backend container from ECR with the required environment
      variables (DB URL, S3 bucket, region, JWT secret, Lambda API key, CORS)
- [ ] Run the frontend container from ECR
- [ ] Ensure containers restart on reboot
- [ ] Verify migrations applied on first boot (backend runs them at startup)

#### Option B — ECS (Fargate or EC2-backed)

- [ ] Create the ECS cluster
- [ ] Create a **task role** (what the containers assume — this is how they
      reach S3 and Secrets Manager, no keys) and a task execution role
      (pulls images, fetches secrets for env vars)
- [ ] Task definitions for backend and frontend using the ECR images
- [ ] Backend task: DB URL + secrets injected from Secrets Manager via the
      task definition; migrations run at container start
- [ ] Services for both tasks; decide and document capacity/health checks
- [ ] If Fargate: verify NAT/egress for private subnets; document the cost

#### Option C — EKS

- [ ] Create the cluster (decide: managed node group, Fargate profile, or
      self-managed nodes — document the choice)
- [ ] Create an **IAM role for the backend service account** (IRSA or EKS Pod
      Identity — decide and document) granting S3 read/write + Secrets Manager
      read; bind it to the backend pod's service account
- [ ] Kubernetes manifests / Helm chart for backend and frontend deployments
      pulling from ECR
- [ ] Secrets/env config for the backend (DB URL, S3 bucket, region, JWT
      secret, Lambda API key, CORS)
- [ ] Migrations: document how `prisma migrate deploy` runs (container start
      vs an init Job)
- [ ] Verify pods pull images and assume the role correctly (no keys in any
      manifest or secret)

### 2.4 S3 bucket (all platforms)

- [ ] Create the S3 bucket (decide: reuse the existing test bucket or create a
      new one for this environment — document the choice)
- [ ] Keep the bucket private (block public access); browser access happens
      only via presigned URLs issued by the backend
- [ ] Configure the bucket CORS policy to allow browser uploads (PUT) and
      gallery reads (GET) from the frontend origin
- [ ] Decide and document the key layout / prefix convention (`uploads/` for
      originals, `processed/` for Lambda output)
- [ ] Decide on lifecycle rules (e.g. expire old `uploads/` originals) —
      optional, document either way
- [ ] Verify presigned upload + download works from the browser through the
      deployed backend

### 2.5 Load balancer and routing (all platforms)

- [ ] Create an ALB in the public subnets
- [ ] Target groups and listeners for frontend and backend
- [ ] Decide and document routing: path-based vs subdomain per service
- [ ] HTTPS (ACM cert) if a domain is available

### 2.6 Lambda and S3 event wiring (all platforms)

- [ ] Deploy the Lambda (image from ECR) with the right memory/timeout
- [ ] Lambda **execution role**: S3 get on `uploads/*`, put on `processed/*`,
      CloudWatch Logs — no keys in Lambda env vars
- [ ] Lambda environment variables: backend URL + shared API key
- [ ] S3 event notification on `uploads/` prefix triggering the Lambda
- [ ] Verify the bucket CORS configuration allows browser uploads

### 2.7 First boot and end-to-end verification (all platforms)

- [ ] Backend reachable through the ALB; gallery endpoint returns 200
- [ ] Admin login works; rotate the default password immediately
- [ ] Full flow: upload from the browser → object in `uploads/` → Lambda
      compresses → object in `processed/` → record shows PROCESSED
- [ ] CloudWatch logs flowing for the app, Lambda, and RDS
- [ ] Audit: confirm no static AWS credentials exist anywhere — not in task
      definitions, pod specs, Lambda config, environment variables, or
      Secrets Manager entries

### 2.8 Terraform (all platforms)

- [ ] Write Terraform for all of the above (or document doing it by hand)
- [ ] Remote state backend configured
- [ ] Document the outputs (ALB URL, RDS endpoint, secrets names)
