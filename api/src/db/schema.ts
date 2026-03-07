// Drizzle ORM schema — wired up in Phase 2 when Postgres is connected
// Keeping the shape here so we can reason about data model early.

import { pgTable, uuid, text, bigint, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const taskStatusEnum = pgEnum("task_status", [
  "open",       // posted, funds locked on-chain
  "claimed",    // a worker claimed it
  "submitted",  // worker submitted a result
  "approved",   // requester approved → funds released
  "expired",    // deadline passed, funds returned to requester
]);

export const tasks = pgTable("tasks", {
  id:            uuid("id").primaryKey().defaultRandom(),
  onchainId:     text("onchain_id").notNull().unique(), // bytes32 taskId on the contract
  requester:     text("requester").notNull(),            // Ethereum address
  worker:        text("worker"),                         // Ethereum address, set on claim
  title:         text("title").notNull(),
  description:   text("description").notNull(),
  amountWei:     bigint("amount_wei", { mode: "bigint" }).notNull(),
  status:        taskStatusEnum("status").default("open").notNull(),
  resultContent: text("result_content"),                 // worker's answer text
  resultHash:    text("result_hash"),                    // keccak256 of result, stored on-chain
  deadlineAt:    timestamp("deadline_at").notNull(),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().notNull(),
});

export const fees = pgTable("fees", {
  id:          uuid("id").primaryKey().defaultRandom(),
  taskId:      uuid("task_id").references(() => tasks.id).notNull(),
  amountWei:   bigint("amount_wei", { mode: "bigint" }).notNull(),
  collectedAt: timestamp("collected_at").defaultNow().notNull(),
});
