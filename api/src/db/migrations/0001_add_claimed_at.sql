ALTER TABLE "tasks" ALTER COLUMN "title" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "description" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "claimed_at" timestamp;