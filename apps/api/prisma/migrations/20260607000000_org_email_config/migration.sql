-- UI-configurable SMTP/email settings (env vars still override at runtime).
ALTER TABLE "Organisation" ADD COLUMN "emailConfig" JSONB NOT NULL DEFAULT '{}';
