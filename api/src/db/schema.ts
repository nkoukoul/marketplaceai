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
  // E2E encryption columns (all nullable — plaintext tasks unaffected)
  // AES-GCM(contentKey, JSON{title,description}) stored as hex nonce|ciphertext+tag
  encryptedPayload:          text("encrypted_payload"),
  // ECIES(requesterPubkey, contentKey) stored as hex ephPub|nonce|ciphertext+tag
  keyWrapForRequester:       text("key_wrap_for_requester"),
  // ECIES(workerPubkey, contentKey) — set by POST /tasks/:id/grant
  keyWrapForWorker:          text("key_wrap_for_worker"),
  // AES-GCM(resultKey, resultText) stored as hex
  encryptedResult:           text("encrypted_result"),
  // ECIES(requesterPubkey, resultKey)
  resultKeyWrapForRequester: text("result_key_wrap_for_requester"),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().notNull(),
});

// Stores the secp256k1 public key recovered from each agent's EIP-712 signature.
// Used by workers to look up the requester's public key for ECIES key-wrapping.
export const agentPubkeys = pgTable("agent_pubkeys", {
  address:   text("address").primaryKey(),
  pubkeyHex: text("pubkey_hex").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
