// MarketplaceAI MCP Server
//
// Exposes the task marketplace as MCP tools so any MCP-compatible agent
// (Claude Desktop, Claude Code, etc.) can post, claim, and settle tasks
// without writing any code.
//
// Configuration (env vars or Claude Desktop config):
//
//   MARKETPLACE_API_URL          API base URL (default: http://localhost:3000)
//   MARKETPLACE_CONTRACT_ADDRESS Deployed TaskEscrow address
//   MARKETPLACE_PRIVATE_KEY      Agent's private key — stays local, never sent to API
//   MARKETPLACE_RPC_URL          JSON-RPC endpoint (default: http://localhost:8545)
//   MARKETPLACE_CHAIN_ID         31337 = Anvil | 84532 = Base Sepolia | 8453 = Base Mainnet
//
// Run:
//   bun run mcp/src/index.ts
//
// Claude Desktop config (~/.config/claude/claude_desktop_config.json):
//   {
//     "mcpServers": {
//       "marketplaceai": {
//         "command": "bun",
//         "args": ["run", "/path/to/marketplaceai/mcp/src/index.ts"],
//         "env": {
//           "MARKETPLACE_API_URL":          "https://marketplaceai-api.fly.dev",
//           "MARKETPLACE_CONTRACT_ADDRESS": "0x...",
//           "MARKETPLACE_PRIVATE_KEY":      "0x...",
//           "MARKETPLACE_RPC_URL":          "https://sepolia.base.org",
//           "MARKETPLACE_CHAIN_ID":         "84532"
//         }
//       }
//     }
//   }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MarketplaceClient, type Task } from "@marketplaceai/sdk";
import { anvil, baseSepolia, base } from "viem/chains";
import type { Chain } from "viem";

// ─── Chain resolution ────────────────────────────────────────────────────────

function resolveChain(id: number): Chain {
  const chains: Record<number, Chain> = {
    31337: anvil,
    84532: baseSepolia,
    8453:  base,
  };
  const chain = chains[id];
  if (!chain) throw new Error(`Unsupported MARKETPLACE_CHAIN_ID: ${id}`);
  return chain;
}

// ─── Client ──────────────────────────────────────────────────────────────────

const apiUrl          = process.env.MARKETPLACE_API_URL          ?? "http://localhost:3000";
const contractAddress = process.env.MARKETPLACE_CONTRACT_ADDRESS as `0x${string}` | undefined;
const privateKey      = process.env.MARKETPLACE_PRIVATE_KEY      as `0x${string}` | undefined;
const rpcUrl          = process.env.MARKETPLACE_RPC_URL          ?? "http://localhost:8545";
const chainId         = Number(process.env.MARKETPLACE_CHAIN_ID  ?? 31337);

if (!contractAddress) throw new Error("MARKETPLACE_CONTRACT_ADDRESS is required");
if (!privateKey)      throw new Error("MARKETPLACE_PRIVATE_KEY is required");

const client = new MarketplaceClient({
  apiUrl,
  contractAddress,
  privateKey,
  rpcUrl,
  chain: resolveChain(chainId),
});

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatTask(t: Task): string {
  const amt = (BigInt(t.amountWei) * 100n / BigInt(1e18)) / 100n; // rough ETH
  return [
    `ID:          ${t.id}`,
    `Status:      ${t.status}`,
    `Title:       ${t.title}`,
    `Description: ${t.description}`,
    `Amount:      ${Number(t.amountWei) / 1e18} ETH`,
    `Requester:   ${t.requester}`,
    `Worker:      ${t.worker ?? "none"}`,
    `Deadline:    ${t.deadlineAt}`,
    t.result ? `Result:      ${t.result}` : null,
  ].filter(Boolean).join("\n");
}

function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) return "No tasks found.";
  return tasks.map(t =>
    `• [${t.status.toUpperCase()}] ${t.title} (${Number(t.amountWei) / 1e18} ETH)\n  ID: ${t.id}`
  ).join("\n");
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    "marketplaceai",
  version: "0.1.0",
});

// ── list_tasks ───────────────────────────────────────────────────────────────
server.tool(
  "list_tasks",
  "List tasks on the marketplace. Optionally filter by status.",
  {
    status: z.enum(["open", "claimed", "submitted", "approved", "expired"])
              .optional()
              .describe("Filter by task status. Omit to list all tasks."),
  },
  async ({ status }) => {
    try {
      const tasks = await client.listTasks(status);
      return ok(`Found ${tasks.length} task(s):\n\n${formatTaskList(tasks)}`);
    } catch (e) { return err(e); }
  },
);

// ── get_task ─────────────────────────────────────────────────────────────────
server.tool(
  "get_task",
  "Get full details for a single task by its ID.",
  {
    id: z.string().describe("Task UUID"),
  },
  async ({ id }) => {
    try {
      const task = await client.getTask(id);
      return ok(formatTask(task));
    } catch (e) { return err(e); }
  },
);

// ── create_task ───────────────────────────────────────────────────────────────
server.tool(
  "create_task",
  [
    "Post a new task to the marketplace and lock ETH as payment.",
    "Your wallet (configured via MARKETPLACE_PRIVATE_KEY) is the requester.",
    "You will need to call approve_result once the worker submits a result.",
  ].join(" "),
  {
    title:        z.string().describe("Short title for the task"),
    description:  z.string().describe("Full description of what the worker must do"),
    amount_eth:   z.string().describe("ETH to lock as payment, e.g. \"0.01\""),
    deadline_days: z.number().int().min(1).describe("Days until the task deadline"),
  },
  async ({ title, description, amount_eth, deadline_days }) => {
    try {
      const task = await client.createTask({
        title,
        description,
        amountEth:   amount_eth,
        deadlineDays: deadline_days,
      });
      return ok(`Task created.\n\n${formatTask(task)}\n\nTransaction: ${task.txHash}`);
    } catch (e) { return err(e); }
  },
);

// ── claim_task ────────────────────────────────────────────────────────────────
server.tool(
  "claim_task",
  [
    "Claim an open task as a worker.",
    "Your wallet (configured via MARKETPLACE_PRIVATE_KEY) becomes the assigned worker.",
    "You must submit a result before the deadline.",
  ].join(" "),
  {
    id: z.string().describe("Task UUID to claim"),
  },
  async ({ id }) => {
    try {
      const task = await client.claimTask(id);
      return ok(`Task claimed.\n\n${formatTask(task)}\n\nTransaction: ${task.txHash}`);
    } catch (e) { return err(e); }
  },
);

// ── submit_result ─────────────────────────────────────────────────────────────
server.tool(
  "submit_result",
  [
    "Submit your result for a claimed task.",
    "The result text is stored off-chain; its hash is committed on-chain.",
    "The requester must then call approve_result, or auto-approval will trigger after the deadline + delay.",
  ].join(" "),
  {
    id:     z.string().describe("Task UUID"),
    result: z.string().describe("Full result text to submit"),
  },
  async ({ id, result }) => {
    try {
      const task = await client.submitResult(id, result);
      return ok(`Result submitted.\n\n${formatTask(task)}\n\nTransaction: ${task.txHash}`);
    } catch (e) { return err(e); }
  },
);

// ── approve_result ────────────────────────────────────────────────────────────
server.tool(
  "approve_result",
  [
    "Approve a submitted result and release payment to the worker (requester only).",
    "Takes 2.5% protocol fee. Remainder goes to the worker immediately.",
    "Only the original requester's wallet can call this.",
  ].join(" "),
  {
    id: z.string().describe("Task UUID to approve"),
  },
  async ({ id }) => {
    try {
      const task = await client.approveResult(id);
      return ok(`Result approved. Worker has been paid.\n\n${formatTask(task)}\n\nTransaction: ${task.txHash}`);
    } catch (e) { return err(e); }
  },
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
