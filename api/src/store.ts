// In-memory task store — Phase 1 placeholder.
// Replaced by Postgres + Drizzle in Phase 2.
// The store holds off-chain metadata (title, description, result text).
// Ground truth for status and funds is always the contract — store mirrors it.

export type TaskStatus = "open" | "claimed" | "submitted" | "approved" | "expired";

export interface StoredTask {
  id: string;           // UUID — our internal primary key
  onchainId: `0x${string}`;  // bytes32 passed to the contract
  requester: string;    // Ethereum address
  worker: string | null;
  title: string;
  description: string;
  amountEth: string;
  status: TaskStatus;
  resultText: string | null;
  resultHash: string | null;
  deadlineAt: string;   // ISO timestamp
  createdAt: string;
}

const tasks = new Map<string, StoredTask>();

export const store = {
  all(): StoredTask[] {
    return [...tasks.values()];
  },

  get(id: string): StoredTask | undefined {
    return tasks.get(id);
  },

  getByOnchainId(onchainId: string): StoredTask | undefined {
    return [...tasks.values()].find((t) => t.onchainId === onchainId);
  },

  create(task: StoredTask): StoredTask {
    tasks.set(task.id, task);
    return task;
  },

  update(id: string, patch: Partial<StoredTask>): StoredTask | undefined {
    const existing = tasks.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    tasks.set(id, updated);
    return updated;
  },
};
