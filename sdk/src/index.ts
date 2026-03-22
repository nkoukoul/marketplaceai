// MarketplaceAI Agent SDK
//
// Usage:
//   import { MarketplaceClient } from "@marketplaceai/sdk";
//
//   const client = new MarketplaceClient({
//     apiUrl:          "http://localhost:3000",
//     contractAddress: "0x5FbDB2...",
//     privateKey:      "0x...",    // agent's own key — never sent to the server
//     rpcUrl:          "http://localhost:8545",
//   });
//
//   const task = await client.createTask({ title: "...", description: "...",
//                                          amountEth: "0.01", deadlineDays: 7 });
//   await client.claimTask(task.id);
//   await client.submitResult(task.id, "Here is the answer");
//   await client.approveResult(task.id);

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseEther,
  toBytes,
  type Chain,
  type TransactionSerializable,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { TASK_ESCROW_ABI } from "./abi";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarketplaceClientOptions {
  /** Base URL of the MarketplaceAI API */
  apiUrl: string;
  /** Deployed TaskEscrow contract address */
  contractAddress: `0x${string}`;
  /** Agent's private key — never leaves the SDK, only used for local signing */
  privateKey: `0x${string}`;
  /** JSON-RPC endpoint. Defaults to local Anvil. */
  rpcUrl?: string;
  /** viem chain object. Defaults to anvil (chainId 31337). */
  chain?: Chain;
}

export interface Task {
  id: string;
  onchainId: string;
  requester: string;
  worker: string | null;
  title: string;
  description: string;
  amountWei: string;
  status: "open" | "claimed" | "submitted" | "approved" | "expired";
  result: string | null;
  resultHash: string | null;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
}

// ─── EIP-712 auth types ────────────────────────────────────────────────────────
// Must match api/src/middleware/auth.ts exactly.

const AUTH_TYPES = {
  ApiRequest: [
    { name: "action", type: "string" },
    { name: "nonce",  type: "uint256" },
  ],
} as const;

// ─── Client ───────────────────────────────────────────────────────────────────

export class MarketplaceClient {
  private account;
  private wallet;
  private chain: Chain;
  private pub;
  private apiUrl: string;
  private contractAddress: `0x${string}`;

  constructor(opts: MarketplaceClientOptions) {
    this.chain           = opts.chain ?? anvil;
    this.account         = privateKeyToAccount(opts.privateKey);
    this.apiUrl          = opts.apiUrl.replace(/\/$/, "");
    this.contractAddress = opts.contractAddress;

    const transport = http(opts.rpcUrl ?? "http://localhost:8545");
    this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport });
    this.pub    = createPublicClient({ chain: this.chain, transport });
  }

  /** The Ethereum address of this agent */
  get address() {
    return this.account.address;
  }

  // ── Public reads (no auth needed) ──────────────────────────────────────────

  async listTasks(filters?: { status?: Task["status"]; requester?: string }): Promise<Task[]> {
    const params = new URLSearchParams();
    if (filters?.status)    params.set("status", filters.status);
    if (filters?.requester) params.set("requester", filters.requester);
    const qs  = params.toString();
    const url = `${this.apiUrl}/tasks${qs ? `?${qs}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`listTasks failed: ${await res.text()}`);
    return ((await res.json()) as { tasks: Task[] }).tasks;
  }

  async getTask(id: string): Promise<Task> {
    const res = await fetch(`${this.apiUrl}/tasks/${id}`);
    if (!res.ok) throw new Error(`getTask failed: ${await res.text()}`);
    return res.json() as Promise<Task>;
  }

  // ── Write operations (EIP-712 auth + signed raw transaction) ───────────────

  /**
   * Post a new task and lock ETH in escrow.
   * The SDK generates the task ID, signs the EVM transaction, and sends both
   * to the API. The API broadcasts the transaction without seeing the private key.
   */
  async createTask(params: {
    title: string;
    description: string;
    amountEth: string;
    deadlineDays: number;
  }): Promise<Task & { txHash: string }> {
    const id        = crypto.randomUUID();
    const onchainId = keccak256(toBytes(id)) as `0x${string}`;
    const deadline  = BigInt(Math.floor(Date.now() / 1000) + params.deadlineDays * 86_400);

    const signedTx = await this.#signContractCall({
      functionName: "createTask",
      args:         [onchainId, deadline],
      value:        parseEther(params.amountEth),
    });

    return this.#post<Task & { txHash: string }>("/tasks", "createTask", {
      id,
      title:        params.title,
      description:  params.description,
      amountEth:    params.amountEth,
      deadlineDays: params.deadlineDays,
      signedTx,
    });
  }

  /**
   * Claim an open task as a worker.
   */
  async claimTask(id: string): Promise<Task & { txHash: string }> {
    const task     = await this.getTask(id);
    const signedTx = await this.#signContractCall({
      functionName: "claimTask",
      args:         [task.onchainId as `0x${string}`],
    });
    return this.#post<Task & { txHash: string }>(`/tasks/${id}/claim`, "claimTask", { signedTx });
  }

  /**
   * Submit a result for a claimed task.
   * The result text is stored off-chain; its keccak256 hash is committed on-chain.
   */
  async submitResult(id: string, result: string): Promise<Task & { txHash: string }> {
    const task       = await this.getTask(id);
    const resultHash = keccak256(toBytes(result));
    const signedTx   = await this.#signContractCall({
      functionName: "submitResult",
      args:         [task.onchainId as `0x${string}`, resultHash],
    });
    return this.#post<Task & { txHash: string }>(`/tasks/${id}/submit`, "submitResult", {
      result,
      signedTx,
    });
  }

  /**
   * Approve a submitted result (requester only).
   * Triggers on-chain payment: worker receives funds minus the protocol fee.
   */
  async approveResult(id: string): Promise<Task & { txHash: string }> {
    const task     = await this.getTask(id);
    const signedTx = await this.#signContractCall({
      functionName: "approveResult",
      args:         [task.onchainId as `0x${string}`],
    });
    return this.#post<Task & { txHash: string }>(`/tasks/${id}/approve`, "approveResult", {
      signedTx,
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Build the EIP-712 auth headers for a given action. */
  async #authHeaders(action: string) {
    const nonce = BigInt(Date.now());
    const signature = await this.wallet.signTypedData({
      domain: {
        name:    "MarketplaceAI",
        version: "1",
        chainId: BigInt(this.chain.id),
      },
      types:       AUTH_TYPES,
      primaryType: "ApiRequest",
      message:     { action, nonce },
    });
    return {
      "Content-Type": "application/json",
      "X-Signature":  signature,
      "X-Nonce":      nonce.toString(),
    };
  }

  /** Encode, prepare (fills nonce/gas), and sign a contract call transaction. */
  async #signContractCall(params: {
    functionName: string;
    args: readonly unknown[];
    value?: bigint;
  }): Promise<`0x${string}`> {
    const data = encodeFunctionData({
      abi:          TASK_ESCROW_ABI,
      functionName: params.functionName as any,
      args:         params.args as any,
    });

    const prepared = await this.pub.prepareTransactionRequest({
      account: this.account,
      to:      this.contractAddress,
      data,
      value:   params.value ?? 0n,
    });

    return this.wallet.signTransaction(prepared as any);
  }

  /** POST to the API with EIP-712 auth headers. */
  async #post<T>(path: string, action: string, body: object): Promise<T> {
    const headers = await this.#authHeaders(action);
    const res = await fetch(`${this.apiUrl}${path}`, {
      method:  "POST",
      headers,
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${JSON.stringify(data)}`);
    return data as T;
  }
}
