ALTER TABLE "QueueEntry" ADD COLUMN IF NOT EXISTS "claimToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "QueueEntry_claimToken_key" ON "QueueEntry"("claimToken");
CREATE INDEX IF NOT EXISTS "QueueEntry_claimToken_idx" ON "QueueEntry"("claimToken");
