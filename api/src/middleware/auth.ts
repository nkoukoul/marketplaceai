// EIP-712 authentication middleware.
//
// Every write request must include two headers:
//   X-Nonce:     millisecond timestamp (BigInt stringified). Rejected if > 5 min old.
//   X-Signature: EIP-712 signature of { action, nonce } signed by the agent.
//
// The middleware recovers the signer's Ethereum address and injects it into
// the Hono context as `signer`. Routes read it with c.get("signer").
// The API never sees a private key — the agent signs everything client-side.

import type { Context, Next } from "hono";
import { recoverTypedDataAddress } from "viem";

export const EIP712_DOMAIN = {
  name: "MarketplaceAI",
  version: "1",
  chainId: BigInt(process.env.CHAIN_ID ?? "31337"),
} as const;

export const AUTH_TYPES = {
  ApiRequest: [
    { name: "action", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const MAX_AGE_MS = 5 * 60 * 1_000; // reject signatures older than 5 minutes

export async function requireAuth(c: Context, next: Next) {
  const signature = c.req.header("x-signature") as `0x${string}` | undefined;
  const nonceStr = c.req.header("x-nonce");

  if (!signature || !nonceStr) {
    return c.json({ error: "missing X-Signature or X-Nonce header" }, 401);
  }

  const nonceMs = Number(nonceStr);
  if (isNaN(nonceMs) || Date.now() - nonceMs > MAX_AGE_MS) {
    return c.json({ error: "signature expired or invalid nonce" }, 401);
  }

  // Determine the action from the request path + method so it can't be
  // copy-pasted across routes (e.g. a "claimTask" sig can't be used on /approve).
  const action = deriveAction(c.req.method, c.req.path);

  try {
    const signer = await recoverTypedDataAddress({
      domain: EIP712_DOMAIN,
      types: AUTH_TYPES,
      primaryType: "ApiRequest",
      message: { action, nonce: BigInt(nonceStr) },
      signature,
    });
    c.set("signer", signer);
  } catch {
    return c.json({ error: "invalid signature" }, 401);
  }

  await next();
}

// Maps HTTP method + path pattern to a canonical action string.
// The SDK must sign with the same string.
function deriveAction(method: string, path: string): string {
  if (method === "POST" && path.endsWith("/approve")) return "approveResult";
  if (method === "POST" && path.endsWith("/submit"))  return "submitResult";
  if (method === "POST" && path.endsWith("/claim"))   return "claimTask";
  if (method === "POST")                              return "createTask";
  return `${method}:${path}`;
}
