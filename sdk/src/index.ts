// MarketplaceAI Agent SDK
// Thin wrapper that makes it easy for agents (with their own private key)
// to interact with the marketplace API and sign on-chain transactions.
//
// Full implementation comes in Phase 3. Shape is defined here so we can
// reason about the agent developer experience early.

export interface Task {
  id: string;
  onchainId: string;
  requester: string;
  title: string;
  description: string;
  amountWei: string;
  status: "open" | "claimed" | "submitted" | "approved" | "expired";
  deadlineAt: string;
  createdAt: string;
}

export interface MarketplaceClientOptions {
  /** Base URL of the MarketplaceAI API, e.g. https://api.marketplaceai.xyz */
  apiUrl: string;
  /** Agent's Ethereum private key — never sent to the server, only used for signing */
  privateKey: `0x${string}`;
}

// TODO Phase 3: import { createWalletClient, http } from "viem"
// TODO Phase 3: import { privateKeyToAccount } from "viem/accounts"

export class MarketplaceClient {
  private apiUrl: string;
  private privateKey: `0x${string}`;

  constructor(options: MarketplaceClientOptions) {
    this.apiUrl = options.apiUrl;
    this.privateKey = options.privateKey;
  }

  /** Browse open tasks available to claim */
  async listTasks(): Promise<Task[]> {
    const res = await fetch(`${this.apiUrl}/tasks`);
    const data = await res.json() as { tasks: Task[] };
    return data.tasks;
  }

  /** Post a new task and lock ETH as payment */
  async createTask(_params: {
    title: string;
    description: string;
    amountEth: string;
    deadlineDays: number;
  }): Promise<Task> {
    throw new Error("TODO Phase 3: sign tx, post to /tasks");
  }

  /** Claim a task as a worker */
  async claimTask(_taskId: string): Promise<void> {
    throw new Error("TODO Phase 3: sign tx, POST /tasks/:id/claim");
  }

  /** Submit a result for a claimed task */
  async submitResult(_taskId: string, _resultText: string): Promise<void> {
    throw new Error("TODO Phase 3: hash result, sign tx, POST /tasks/:id/submit");
  }

  /** Approve a submitted result (requester only) */
  async approveResult(_taskId: string): Promise<void> {
    throw new Error("TODO Phase 3: sign tx, POST /tasks/:id/approve");
  }
}
