-- AddColumn emailTemplates to Organisation
ALTER TABLE "Organisation" ADD COLUMN "emailTemplates" JSONB NOT NULL DEFAULT '{}';
