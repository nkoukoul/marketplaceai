import { Hono } from "hono";
import { keccak256, toBytes, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { tasks } from "../db/schema";
import {
  sendCreateTask,
  sendClaimTask,
  sendSubmitResult,
  sendApproveResult,
  readTask,
} from "../chain/escrow";

const router = new Hono();

// ─── GET /tasks ───────────────────────────────────────────────────────────────
router.get("/", async (c) => {
  const statusFilter = c.req.query("status") as string | undefined;
  const rows = statusFilter
    ? await db.select().from(tasks).where(eq(tasks.status, statusFilter as any))
    : await db.select().from(tasks);
  return c.json({ tasks: rows.map(serialize) });
});

// ─── GET /tasks/:id ───────────────────────────────────────────────────────────
router.get("/:id", async (c) => {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")));
  if (!task) return c.json({ error: "task not found" }, 404);

  // Sync fresh status from chain
  const onchain = await readTask(task.onchainId as `0x${string}`);
  const [updated] = await db
    .update(tasks)
    .set({
      status: onchain.status as any,
      worker: onchain.worker ?? task.worker ?? undefined,
      resultHash: onchain.resultHash ?? task.resultHash ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, task.id))
    .returning();

  return c.json(serialize(updated));
});

// ─── POST /tasks ──────────────────────────────────────────────────────────────
// Body: { title, description, amountEth, deadlineDays, signerKey }
router.post("/", async (c) => {
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

  // Derive requester address from the key — never stored server-side
  const requester = privateKeyToAccount(signerKey).address;

  const id = crypto.randomUUID();
  const onchainId = keccak256(toBytes(id)) as `0x${string}`;
  const deadlineSecs = BigInt(Math.floor(Date.now() / 1000) + deadlineDays * 86_400);

  const txHash = await sendCreateTask({
    onchainId,
    deadlineTimestamp: deadlineSecs,
    amountEth,
    signerKey,
  });

  const [task] = await db
    .insert(tasks)
    .values({
      id,
      onchainId,
      requester,
      amountWei: parseEther(amountEth),
      title,
      description,
      status: "open",
      deadlineAt: new Date(Number(deadlineSecs) * 1000),
    })
    .returning();

  return c.json({ ...serialize(task), txHash }, 201);
});

// ─── POST /tasks/:id/claim ────────────────────────────────────────────────────
// Body: { signerKey }
router.post("/:id/claim", async (c) => {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")));
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status !== "open") return c.json({ error: `task is ${task.status}, not open` }, 409);

  const { signerKey } = await c.req.json<{ signerKey: `0x${string}` }>();
  if (!signerKey) return c.json({ error: "missing signerKey" }, 400);

  const worker = privateKeyToAccount(signerKey).address;
  const txHash = await sendClaimTask({ onchainId: task.onchainId as `0x${string}`, signerKey });

  const [updated] = await db
    .update(tasks)
    .set({ status: "claimed", worker, updatedAt: new Date() })
    .where(eq(tasks.id, task.id))
    .returning();

  return c.json({ ...serialize(updated), txHash });
});

// ─── POST /tasks/:id/submit ───────────────────────────────────────────────────
// Body: { result, signerKey }
router.post("/:id/submit", async (c) => {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")));
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status !== "claimed") return c.json({ error: `task is ${task.status}, not claimed` }, 409);

  const { result, signerKey } = await c.req.json<{ result: string; signerKey: `0x${string}` }>();
  if (!result || !signerKey) return c.json({ error: "missing result or signerKey" }, 400);

  const { txHash, resultHash } = await sendSubmitResult({
    onchainId: task.onchainId as `0x${string}`,
    resultText: result,
    signerKey,
  });

  const [updated] = await db
    .update(tasks)
    .set({ status: "submitted", resultContent: result, resultHash, updatedAt: new Date() })
    .where(eq(tasks.id, task.id))
    .returning();

  return c.json({ ...serialize(updated), txHash });
});

// ─── POST /tasks/:id/approve ──────────────────────────────────────────────────
// Body: { signerKey }
router.post("/:id/approve", async (c) => {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")));
  if (!task) return c.json({ error: "task not found" }, 404);
  if (task.status !== "submitted") return c.json({ error: `task is ${task.status}, not submitted` }, 409);

  const { signerKey } = await c.req.json<{ signerKey: `0x${string}` }>();
  if (!signerKey) return c.json({ error: "missing signerKey" }, 400);

  const txHash = await sendApproveResult({ onchainId: task.onchainId as `0x${string}`, signerKey });

  const [updated] = await db
    .update(tasks)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(tasks.id, task.id))
    .returning();

  return c.json({ ...serialize(updated), txHash });
});

// ─── Serialise DB row for JSON response ───────────────────────────────────────
function serialize(task: typeof tasks.$inferSelect) {
  return {
    id:          task.id,
    onchainId:   task.onchainId,
    requester:   task.requester,
    worker:      task.worker,
    title:       task.title,
    description: task.description,
    amountWei:   task.amountWei?.toString(),
    status:      task.status,
    result:      task.resultContent,
    resultHash:  task.resultHash,
    deadlineAt:  task.deadlineAt.toISOString(),
    createdAt:   task.createdAt.toISOString(),
    updatedAt:   task.updatedAt.toISOString(),
  };
}

export default router;
