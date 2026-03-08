// Background job: optimistic auto-approval.
//
// Every 60 seconds this job:
//   1. Queries the DB for tasks that are "submitted" and past their
//      auto-approve deadline (deadlineAt + autoApproveDelay).
//   2. Calls autoApprove() on the contract for each eligible task.
//   3. The on-chain call emits ResultApproved, which the indexer picks up
//      and writes back to the DB — no manual DB update needed here.
//
// autoApprove() is permissionless — any address can call it.
// The relayer just pays the gas; it never moves user funds.

import { lt, eq } from "drizzle-orm";
import { db } from "../db";
import { tasks } from "../db/schema";
import { publicClient } from "./client";
import { relayerWallet, relayerAddress } from "./relayer";
import { TASK_ESCROW_ABI } from "./abi";

const CONTRACT  = (process.env.CONTRACT_ADDRESS ?? "") as `0x${string}`;
const POLL_MS   = 60_000; // check every 60 seconds

export async function startAutoApproveJob() {
  // Read the delay once from the contract at startup
  const delaySeconds = await publicClient.readContract({
    address: CONTRACT,
    abi: TASK_ESCROW_ABI,
    functionName: "autoApproveDelay",
  });
  const delayMs = Number(delaySeconds) * 1000;

  console.log(`AutoApprove: delay = ${Number(delaySeconds)}s, polling every ${POLL_MS / 1000}s`);
  console.log(`AutoApprove: relayer = ${relayerAddress}`);

  const run = async () => {
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
  };

  // Run once immediately, then on interval
  await run();
  setInterval(run, POLL_MS);
}
