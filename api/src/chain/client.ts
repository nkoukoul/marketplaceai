import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain } from "./chain";

const rpcUrl = process.env.RPC_URL ?? "http://localhost:8545";

// Read-only client — used for calling view functions and reading events.
// No private key needed.
export const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl),
});

// Returns a wallet client bound to a specific private key.
export function walletClientFromKey(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  return {
    client: createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    }),
    account,
  };
}
