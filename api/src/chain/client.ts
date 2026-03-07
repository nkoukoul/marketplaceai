import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";

const rpcUrl = process.env.RPC_URL ?? "http://localhost:8545";

// Read-only client — used for calling view functions and reading events.
// No private key needed.
export const publicClient = createPublicClient({
  chain: anvil,
  transport: http(rpcUrl),
});

// Returns a wallet client bound to a specific private key.
// In Phase 1 (dev), the caller passes their own key via the request body.
// In Phase 3, agents will sign transactions client-side via the SDK.
export function walletClientFromKey(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  return {
    client: createWalletClient({
      account,
      chain: anvil,
      transport: http(rpcUrl),
    }),
    account,
  };
}
