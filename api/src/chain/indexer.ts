// Event indexer — polls the TaskEscrow contract for on-chain events
// and syncs them into the Postgres DB.
//
// Uses getLogs with explicit block tracking so we never replay historical
// events from before the API started.

import { decodeEventLog } from "viem";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { tasks } from "../db/schema";
import { publicClient } from "./client";
import { TASK_ESCROW_ABI } from "./abi";

const contractAddress = (process.env.CONTRACT_ADDRESS ?? "") as `0x${string}`;
const POLL_INTERVAL_MS = 2_000;

export async function startIndexer() {
  // Start from the current block — never replay history
  let fromBlock = await publicClient.getBlockNumber();
  console.log(`Indexer: started at block ${fromBlock}, watching ${contractAddress}`);

  setInterval(async () => {
    try {
      const toBlock = await publicClient.getBlockNumber();
      if (toBlock <= fromBlock) return;

      const logs = await publicClient.getLogs({
        address: contractAddress,
        fromBlock: fromBlock + 1n,
        toBlock,
      });

      for (const log of logs) {
        try {
          const { eventName, args } = decodeEventLog({
            abi: TASK_ESCROW_ABI,
            data: log.data,
            topics: log.topics,
          });
          await handleEvent(eventName, args);
        } catch {
          // Unknown event signature — skip
        }
      }

      fromBlock = toBlock;
    } catch (e: any) {
      console.error("Indexer poll error:", e.message);
    }
  }, POLL_INTERVAL_MS);
}

async function handleEvent(eventName: string, args: Record<string, unknown>) {
  switch (eventName) {
    case "TaskClaimed": {
      const { taskId, worker } = args as { taskId: `0x${string}`; worker: `0x${string}` };
      await db.update(tasks)
        .set({ status: "claimed", worker, updatedAt: new Date() })
        .where(eq(tasks.onchainId, taskId));
      console.log(`Indexer: TaskClaimed  ${taskId.slice(0, 10)}…`);
      break;
    }
    case "ResultSubmitted": {
      const { taskId, resultHash } = args as { taskId: `0x${string}`; resultHash: `0x${string}` };
      await db.update(tasks)
        .set({ status: "submitted", resultHash, updatedAt: new Date() })
        .where(eq(tasks.onchainId, taskId));
      console.log(`Indexer: ResultSubmitted ${taskId.slice(0, 10)}…`);
      break;
    }
    case "ResultApproved": {
      const { taskId } = args as { taskId: `0x${string}` };
      await db.update(tasks)
        .set({ status: "approved", updatedAt: new Date() })
        .where(eq(tasks.onchainId, taskId));
      console.log(`Indexer: ResultApproved  ${taskId.slice(0, 10)}…`);
      break;
    }
    case "TaskExpired": {
      const { taskId } = args as { taskId: `0x${string}` };
      await db.update(tasks)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(tasks.onchainId, taskId));
      console.log(`Indexer: TaskExpired  ${taskId.slice(0, 10)}…`);
      break;
    }
  }
}
