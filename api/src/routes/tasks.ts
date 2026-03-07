import { Hono } from "hono";
import { keccak256, toBytes } from "viem";
import { store } from "../store";
import {
  sendCreateTask,
  sendClaimTask,
  sendSubmitResult,
  sendApproveResult,
  readTask,
} from "../chain/escrow";

const tasks = new Hono();

// ─── GET /tasks ───────────────────────────────────────────────────────────────
// List all tasks in the store. Optional ?status= filter.

tasks.get("/", (c) => {
  const statusFilter = c.req.query("status");
  const all = store.all();
  const result = statusFilter ? all.filter((t) => t.status === statusFilter) : all;
  return c.json({ tasks: result });
});

// ─── GET /tasks/:id ───────────────────────────────────────────────────────────
// Get a single task. Reads fresh status from chain.

tasks.get("/:id", async (c) => {
  const task = store.get(c.req.param("id"));
  if (!task) return c.json({ error: "task not found" }, 404);

  // Sync status from chain so it's always fresh
  const onchain = await readTask(task.onchainId);
  const updated = store.update(task.id, {
    status: onchain.status as any,
    worker: onchain.worker ?? task.worker,
    resultHash: onchain.resultHash ?? task.resultHash,
  });

  return c.json(updated);
});

// ─── POST /tasks ──────────────────────────────────────────────────────────────
// Create a task and lock ETH in escrow.
//
// Body:
//   title        string   human-readable task name
//   description  string   what needs to be done
//   amountEth    string   ETH to lock, e.g. "0.01"
//   deadlineDays number   days until the task expires
//   signerKey    string   private key of the requester (dev mode)

tasks.post("/", async (c) => {
  const body = await c.req.json<{
    title: string;
    description: string;
    amountEth: string;
    deadlineDays: number;
    signerKey: `0x${string}`;
  }>();

  const { title, description, amountEth, deadlineDays, signerKey } = body;
  if (!title || !description || !amountEth || !deadlineDays || !signerKey) {
    return c.json({ error: "missing required fields" }, 400);
  }

  const id = crypto.randomUUID();
  // Derive a deterministic bytes32 from the UUID
  const onchainId = keccak256(toBytes(id)) as `0x${string}`;
  const deadlineTimestamp = BigInt(Math.floor(Date.now() / 1000) + deadlineDays * 86400);
  const deadlineAt = new Date(Number(deadlineTimestamp) * 1000).toISOString();

  const txHash = await sendCreateTask({ onchainId, deadlineTimestamp, amountEth, signerKey });

  const task = store.create({
    id,
    onchainId,
    requester: "pending", // resolved from chain event in Phase 2
    worker: null,
    title,
    description,
    amountEth,
    status: "open",
    resultText: null,
    resultHash: null,
    deadlineAt,
    createdAt: new Date().toISOString(),
  });

  return c.json({ ...task, txHash }, 201);
});

// ─── POST /tasks/:id/claim ────────────────────────────────────────────────────
// Worker claims a task.
//
// Body:
//   signerKey  string  private key of the worker (dev mode)

tasks.post("/:id/claim", async (c) => {
  const task = store.get(c.req.param("id"));
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status !== "open") return c.json({ error: `task is ${task.status}, not open` }, 409);

  const { signerKey } = await c.req.json<{ signerKey: `0x${string}` }>();
  if (!signerKey) return c.json({ error: "missing signerKey" }, 400);

  const txHash = await sendClaimTask({ onchainId: task.onchainId, signerKey });

  // Derive worker address from key to store it
  const { privateKeyToAccount } = await import("viem/accounts");
  const worker = privateKeyToAccount(signerKey).address;

  const updated = store.update(task.id, { status: "claimed", worker });
  return c.json({ ...updated, txHash });
});

// ─── POST /tasks/:id/submit ───────────────────────────────────────────────────
// Worker submits their result.
//
// Body:
//   result     string  the actual answer / work product
//   signerKey  string  private key of the worker (dev mode)

tasks.post("/:id/submit", async (c) => {
  const task = store.get(c.req.param("id"));
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status !== "claimed") return c.json({ error: `task is ${task.status}, not claimed` }, 409);

  const { result, signerKey } = await c.req.json<{ result: string; signerKey: `0x${string}` }>();
  if (!result || !signerKey) return c.json({ error: "missing result or signerKey" }, 400);

  const { txHash, resultHash } = await sendSubmitResult({
    onchainId: task.onchainId,
    resultText: result,
    signerKey,
  });

  const updated = store.update(task.id, {
    status: "submitted",
    resultText: result,
    resultHash,
  });

  return c.json({ ...updated, txHash });
});

// ─── POST /tasks/:id/approve ──────────────────────────────────────────────────
// Requester approves the result → triggers on-chain payment.
//
// Body:
//   signerKey  string  private key of the requester (dev mode)

tasks.post("/:id/approve", async (c) => {
  const task = store.get(c.req.param("id"));
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status !== "submitted") return c.json({ error: `task is ${task.status}, not submitted` }, 409);

  const { signerKey } = await c.req.json<{ signerKey: `0x${string}` }>();
  if (!signerKey) return c.json({ error: "missing signerKey" }, 400);

  const txHash = await sendApproveResult({ onchainId: task.onchainId, signerKey });
  const updated = store.update(task.id, { status: "approved" });

  return c.json({ ...updated, txHash });
});

export default tasks;
