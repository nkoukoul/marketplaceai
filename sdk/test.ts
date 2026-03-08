// Integration test — runs the full task lifecycle using the SDK.
//
// Prerequisites:
//   1. anvil running on :8545
//   2. TaskEscrow deployed (forge script contracts/script/Deploy.s.sol --broadcast)
//   3. API running on :3000 (bun run --cwd api src/index.ts)
//
// Run:
//   bun run sdk/test.ts

import { MarketplaceClient } from "./src/index";

// Anvil's default funded accounts (keys are public — local dev only)
const REQUESTER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WORKER_KEY    = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const CONTRACT      = "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6";
const API_URL       = "http://localhost:3000";
const RPC_URL       = "http://localhost:8545";

const requester = new MarketplaceClient({
  apiUrl: API_URL, contractAddress: CONTRACT,
  privateKey: REQUESTER_KEY, rpcUrl: RPC_URL,
});

const worker = new MarketplaceClient({
  apiUrl: API_URL, contractAddress: CONTRACT,
  privateKey: WORKER_KEY, rpcUrl: RPC_URL,
});

function log(step: string, data: Record<string, unknown>) {
  const { status, txHash, id, requester: req, worker: w, result } = data as any;
  console.log(`\n[${step}]`);
  if (id)      console.log(`  id:        ${id}`);
  if (status)  console.log(`  status:    ${status}`);
  if (req)     console.log(`  requester: ${req}`);
  if (w)       console.log(`  worker:    ${w}`);
  if (result)  console.log(`  result:    ${result}`);
  if (txHash)  console.log(`  txHash:    ${txHash}`);
}

async function main() {
  console.log("MarketplaceAI SDK — integration test");
  console.log(`  Requester: ${requester.address}`);
  console.log(`  Worker:    ${worker.address}`);

  // 1. Requester posts a task and locks 0.01 ETH
  const task = await requester.createTask({
    title:       "Translate 'hello world' to Spanish",
    description: "Provide the Spanish translation of the phrase 'hello world'.",
    amountEth:   "0.01",
    deadlineDays: 7,
  });
  log("CREATE", task);
  if (task.status !== "open") throw new Error("Expected status: open");

  // 2. Worker claims the task
  const claimed = await worker.claimTask(task.id);
  log("CLAIM", claimed);
  if (claimed.status !== "claimed") throw new Error("Expected status: claimed");

  // 3. Worker submits their result
  const submitted = await worker.submitResult(task.id, "Hola mundo");
  log("SUBMIT", submitted);
  if (submitted.status !== "submitted") throw new Error("Expected status: submitted");

  // 4. Requester approves — funds are released on-chain
  const approved = await requester.approveResult(task.id);
  log("APPROVE", approved);
  if (approved.status !== "approved") throw new Error("Expected status: approved");

  console.log("\n✓ Full lifecycle complete. All assertions passed.");
}

main().catch((err) => {
  console.error("\n✗ Test failed:", err.message);
  process.exit(1);
});
