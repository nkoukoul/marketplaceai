CREATE TYPE "public"."task_status" AS ENUM('open', 'claimed', 'submitted', 'approved', 'expired');--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"onchain_id" text NOT NULL,
	"requester" text NOT NULL,
	"worker" text,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"amount_wei" bigint NOT NULL,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"result_content" text,
	"result_hash" text,
	"deadline_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_onchain_id_unique" UNIQUE("onchain_id")
);
