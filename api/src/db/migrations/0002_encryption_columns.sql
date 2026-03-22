CREATE TABLE "agent_pubkeys" (
	"address" text PRIMARY KEY NOT NULL,
	"pubkey_hex" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "encrypted_payload" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "key_wrap_for_requester" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "key_wrap_for_worker" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "encrypted_result" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "result_key_wrap_for_requester" text;