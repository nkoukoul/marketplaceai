// Typed wrappers around the TaskEscrow contract.
// Read functions use the public client (no key needed).
// Write functions accept a pre-signed raw transaction from the agent —
// the API broadcasts it without ever seeing a private key.

import { formatEther } from "viem";
import { publicClient } from "./client";
import { TASK_ESCROW_ABI } from "./abi";

const contractAddress = (process.env.CONTRACT_ADDRESS ?? "") as `0x${string}`;

if (!contractAddress) {
  throw new Error("CONTRACT_ADDRESS env var is not set");
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function readTask(onchainId: `0x${string}`) {
  const task = await publicClient.readContract({
    address: contractAddress,
    abi: TASK_ESCROW_ABI,
    functionName: "getTask",
    args: [onchainId],
  });

  const statusMap = ["open", "claimed", "submitted", "approved", "expired"] as const;

  return {
    requester: task.requester,
    worker: task.worker === "0x0000000000000000000000000000000000000000" ? null : task.worker,
    amountEth: formatEther(task.amount),
    deadline: new Date(Number(task.deadline) * 1000).toISOString(),
    status: statusMap[task.status] ?? "unknown",
    resultHash:
      task.resultHash === "0x0000000000000000000000000000000000000000000000000000000000000000"
        ? null
        : task.resultHash,
  };
}

export async function readFeeBps(): Promise<number> {
  return await publicClient.readContract({
    address: contractAddress,
    abi: TASK_ESCROW_ABI,
    functionName: "feeBps",
  });
}

export async function readPendingFees(): Promise<string> {
  const fees = await publicClient.readContract({
    address: contractAddress,
    abi: TASK_ESCROW_ABI,
    functionName: "pendingFees",
  });
  return formatEther(fees);
}

// ─── Writes ───────────────────────────────────────────────────────────────────

// Broadcast a raw signed transaction that was constructed and signed by the agent.
// The API never holds a private key — it just submits what the agent sent.
export async function broadcastSignedTx(serializedTransaction: `0x${string}`) {
  const hash = await publicClient.sendRawTransaction({ serializedTransaction });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
