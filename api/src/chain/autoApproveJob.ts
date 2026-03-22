// Background job: optimistic auto-approval + stale-claim release.
//
// Every 60 seconds this job runs two loops:
//
// 1. Auto-approve: finds "submitted" tasks past their auto-approve deadline
//    (deadlineAt + autoApproveDelay) and calls autoApprove() on the contract.
//    The on-chain call emits ResultApproved, which the indexer picks up
//    and writes back to the DB — no manual DB update needed here.
//
// 2. Stale-claim release: finds "claimed" tasks where claimedAt + claimTimeout
//    < now and calls releaseStaleClaimTask() on the contract.
//    The on-chain call emits TaskReleased; the indexer updates the DB.
//
// Both functions are permissionless — any address can call them.
// The relayer just pays the gas; it never moves user funds.

import { lt, eq, and, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { tasks } from "../db/schema";
import { publicClient } from "./client";
import { relayerWallet, relayerAddress } from "./relayer";
import { TASK_ESCROW_ABI } from "./abi";

const CONTRACT  = (process.env.CONTRACT_ADDRESS ?? "") as `0x${string}`;
const POLL_MS   = 60_000; // check every 60 seconds

export async function startAutoApproveJob() {
  // Read delays once from the contract at startup
  const [autoApproveDelaySeconds, claimTimeoutSeconds] = await Promise.all([
    publicClient.readContract({
      address: CONTRACT,
      abi: TASK_ESCROW_ABI,
      functionName: "autoApproveDelay",
    }),
    publicClient.readContract({
      address: CONTRACT,
      abi: TASK_ESCROW_ABI,
      functionName: "claimTimeout",
    }),
  ]);

  const autoApproveDelayMs = Number(autoApproveDelaySeconds) * 1000;
  const claimTimeoutMs     = Number(claimTimeoutSeconds) * 1000;

  console.log(`AutoApprove: delay = ${Number(autoApproveDelaySeconds)}s, polling every ${POLL_MS / 1000}s`);
  console.log(`StaleClaimRelease: timeout = ${Number(claimTimeoutSeconds)}s`);
  console.log(`Relayer: ${relayerAddress}`);

  const run = async () => {
    await Promise.all([
      runAutoApprove(autoApproveDelayMs),
      runStaleClaimRelease(claimTimeoutMs),
    ]);
  };

  // Run once immediately, then on interval
  await run();
  setInterval(run, POLL_MS);
}

async function runAutoApprove(delayMs: number) {
  try {
    const cutoff = new Date(Date.now() - delayMs);

    // Find submitted tasks whose deadline passed more than delaySeconds ago
    const eligible = await db
      .select()
      .from(tasks)
      .where(eq(tasks.status, "submitted"))
      // deadlineAt + delay < now  →  deadlineAt < now - delay
      .then(rows => rows.filter(t => t.deadlineAt < cutoff));

    for (const task of eligible) {
      try {
        console.log(`AutoApprove: triggering for task ${task.id}`);
        const hash = await relayerWallet.writeContract({
          address: CONTRACT,
          abi: TASK_ESCROW_ABI,
          functionName: "autoApprove",
          args: [task.onchainId as `0x${string}`],
          account: relayerAddress,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`AutoApprove: settled task ${task.id} (tx ${hash})`);
      } catch (e: any) {
        // AutoApproveNotReady means the on-chain clock disagrees with our DB
        // deadline — harmless, will retry next poll.
        console.warn(`AutoApprove: skipped task ${task.id}: ${e.shortMessage ?? e.message}`);
      }
    }
  } catch (e: any) {
    console.error("AutoApprove job error:", e.message);
  }
}

async function runStaleClaimRelease(timeoutMs: number) {
  try {
    const cutoff = new Date(Date.now() - timeoutMs);

    // Find claimed tasks where claimedAt is set and older than claimTimeout
    const eligible = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, "claimed"), isNotNull(tasks.claimedAt)))
      .then(rows => rows.filter(t => t.claimedAt !== null && t.claimedAt < cutoff));

    for (const task of eligible) {
      try {
        console.log(`StaleClaimRelease: releasing task ${task.id}`);
        const hash = await relayerWallet.writeContract({
          address: CONTRACT,
          abi: TASK_ESCROW_ABI,
          functionName: "releaseStaleClaimTask",
          args: [task.onchainId as `0x${string}`],
          account: relayerAddress,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`StaleClaimRelease: released task ${task.id} (tx ${hash})`);
      } catch (e: any) {
        // ClaimNotExpired means on-chain clock disagrees — harmless, will retry.
        console.warn(`StaleClaimRelease: skipped task ${task.id}: ${e.shortMessage ?? e.message}`);
      }
    }
  } catch (e: any) {
    console.error("StaleClaimRelease job error:", e.message);
  }
}
