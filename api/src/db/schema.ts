import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";

export const taskStatusEnum = pgEnum("task_status", [
  "open",
  "claimed",
  "submitted",
  "approved",
  "expired",
]);

export const tasks = pgTable("tasks", {
  id:            uuid("id").primaryKey().defaultRandom(),
  onchainId:     text("onchain_id").notNull().unique(),
  requester:     text("requester").notNull(),
  worker:        text("worker"),
  title:         text("title").notNull().default(""),
  description:   text("description").notNull().default(""),
  amountWei:     bigint("amount_wei", { mode: "bigint" }).notNull(),
  status:        taskStatusEnum("status").default("open").notNull(),
  resultContent: text("result_content"),
  resultHash:    text("result_hash"),
  deadlineAt:    timestamp("deadline_at").notNull(),
  claimedAt:     timestamp("claimed_at"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().notNull(),
});
