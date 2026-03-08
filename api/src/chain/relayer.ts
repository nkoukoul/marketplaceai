// Server-side relayer wallet.
//
// Used only for permissionless on-chain calls that the API triggers on behalf
// of the protocol — specifically autoApprove(). The relayer never touches user
// funds; it only pays gas for the autoApprove transaction.
//
// The RELAYER_PRIVATE_KEY env var must be funded with a small amount of ETH
// for gas. For local Anvil this is any of the pre-funded accounts.

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";

const key = process.env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error("RELAYER_PRIVATE_KEY env var is not set");

const account = privateKeyToAccount(key);

export const relayerWallet = createWalletClient({
  account,
  chain: anvil,
  transport: http(process.env.RPC_URL ?? "http://localhost:8545"),
});

export const relayerAddress = account.address;
