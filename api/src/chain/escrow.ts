// Typed wrappers around the TaskEscrow contract.
// Each function either reads from chain (publicClient) or sends a transaction
// (walletClient). All values are returned as plain JS types — viem bigints are
// converted to strings so they survive JSON serialisation.

import { parseEther, keccak256, toBytes, formatEther } from "viem";
import { publicClient, walletClientFromKey } from "./client";
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
    resultHash: task.resultHash === "0x0000000000000000000000000000000000000000000000000000000000000000"
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

export async function sendCreateTask(params: {
  onchainId: `0x${string}`;
  deadlineTimestamp: bigint;
  amountEth: string;
  signerKey: `0x${string}`;
}) {
  const { client, account } = walletClientFromKey(params.signerKey);
  const hash = await client.writeContract({
    address: contractAddress,
    abi: TASK_ESCROW_ABI,
    functionName: "createTask",
    args: [params.onchainId, params.deadlineTimestamp],
    value: parseEther(params.amountEth),
    account,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function sendClaimTask(params: {
  onchainId: `0x${string}`;
  signerKey: `0x${string}`;
}) {
  const { client, account } = walletClientFromKey(params.signerKey);
  const hash = await client.writeContract({
    address: contractAddress,
    abi: TASK_ESCROW_ABI,
    functionName: "claimTask",
    args: [params.onchainId],
    account,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function sendSubmitResult(params: {
  onchainId: `0x${string}`;
  resultText: string;
  signerKey: `0x${string}`;
}) {
  const resultHash = keccak256(toBytes(params.resultText));
  const { client, account } = walletClientFromKey(params.signerKey);
  const hash = await client.writeContract({
    address: contractAddress,
    abi: TASK_ESCROW_ABI,
    functionName: "submitResult",
    args: [params.onchainId, resultHash],
    account,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { txHash: hash, resultHash };
}

export async function sendApproveResult(params: {
  onchainId: `0x${string}`;
  signerKey: `0x${string}`;
}) {
  const { client, account } = walletClientFromKey(params.signerKey);
  const hash = await client.writeContract({
    address: contractAddress,
    abi: TASK_ESCROW_ABI,
    functionName: "approveResult",
    args: [params.onchainId],
    account,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
