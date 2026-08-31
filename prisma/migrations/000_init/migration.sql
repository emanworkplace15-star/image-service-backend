-- Initial schema: users (admin seeded), images
-- Runs via `prisma migrate deploy` (also runs automatically in the Docker container CMD).
-- Note: enum types keep Prisma's PascalCase names (no @@map on the enums).

CREATE TYPE "UserRole" AS ENUM ('ADMIN');
CREATE TYPE "ImageStatus" AS ENUM ('PENDING', 'UPLOADED', 'PROCESSED', 'FAILED');

CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ADMIN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE TABLE "images" (
    "id" TEXT NOT NULL,
    "original_key" TEXT NOT NULL,
    "processed_key" TEXT,
    "original_size" INTEGER,
    "processed_size" INTEGER,
    "content_type" TEXT NOT NULL,
    "status" "ImageStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "images_original_key_key" ON "images"("original_key");

-- Seed admin user: admin@local / admin123 (bcrypt, cost 10).
-- CHANGE THIS PASSWORD AFTER FIRST LOGIN. To rotate, generate a new hash:
--   node -e "require('bcrypt').hash('<new-password>', 10).then(console.log)"
-- and run: UPDATE users SET password_hash = '<new-hash>' WHERE email = 'admin@local';
INSERT INTO "users" ("id", "email", "password_hash", "role", "created_at", "updated_at")
VALUES (
    gen_random_uuid(),
    'admin@local',
    '$2b$10$sK3/C.HukIOU0O79vM69f.EzrHrwkhuGy/6ZdpAQIiCOhzpHZ29Jq',
    'ADMIN',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);
