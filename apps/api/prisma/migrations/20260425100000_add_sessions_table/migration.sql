-- CreateTable
CREATE TABLE IF NOT EXISTS "sessions" (
    "sid"    VARCHAR NOT NULL,
    "sess"   JSON NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("sid")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "sessions"("expire");
