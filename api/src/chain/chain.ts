// Resolves the viem Chain object from the CHAIN_ID environment variable.
// Defaults to Anvil (31337) for local development.
//
// Supported chain IDs:
//   31337  — Anvil (local)
//   84532  — Base Sepolia (testnet)
//   8453   — Base Mainnet

import { anvil, baseSepolia, base } from "viem/chains";
import type { Chain } from "viem";

const chainId = Number(process.env.CHAIN_ID ?? 31337);

const CHAINS: Record<number, Chain> = {
  31337: anvil,
  84532: baseSepolia,
  8453:  base,
};

export const chain = CHAINS[chainId];
if (!chain) throw new Error(`Unsupported CHAIN_ID: ${chainId}`);
