// EIP-712 authentication middleware.
//
// Every write request must include two headers:
//   X-Nonce:     millisecond timestamp (BigInt stringified). Rejected if > 5 min old.
//   X-Signature: EIP-712 signature of { action, nonce } signed by the agent.
//
// The middleware recovers the signer's Ethereum address and injects it into
// the Hono context as `signer`. Routes read it with c.get("signer").
// The API never sees a private key — the agent signs everything client-side.
//
// Side effect: the full secp256k1 public key is upserted into agent_pubkeys
// so other agents can look it up for ECIES key-wrapping.

import type { Context, Next } from "hono";
import { recoverTypedDataAddress, hashTypedData, recoverPublicKey } from "viem";
import { db } from "../db";
import { agentPubkeys } from "../db/schema";

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

  const typedDataParams = {
    domain: EIP712_DOMAIN,
    types: AUTH_TYPES,
    primaryType: "ApiRequest" as const,
    message: { action, nonce: BigInt(nonceStr) },
  };

  try {
    const signer = await recoverTypedDataAddress({
      ...typedDataParams,
      signature,
    });
    c.set("signer", signer);

    // Fire-and-forget: capture full public key for ECIES key-wrapping.
    // Never blocks or fails the request.
    capturePublicKey(typedDataParams, signature, signer).catch(() => {});
  } catch {
    return c.json({ error: "invalid signature" }, 401);
  }

  await next();
}

async function capturePublicKey(
  typedDataParams: Parameters<typeof hashTypedData>[0],
  signature: `0x${string}`,
  signer: `0x${string}`,
) {
  const hash = hashTypedData(typedDataParams);
  const pubkeyHex = await recoverPublicKey({ hash, signature });
  await db
    .insert(agentPubkeys)
    .values({ address: signer.toLowerCase(), pubkeyHex, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: agentPubkeys.address,
      set: { pubkeyHex, updatedAt: new Date() },
    });
}

// Maps HTTP method + path pattern to a canonical action string.
// The SDK must sign with the same string.
function deriveAction(method: string, path: string): string {
  if (method === "POST" && path.endsWith("/approve"))      return "approveResult";
  if (method === "POST" && path.endsWith("/submit"))       return "submitResult";
  if (method === "POST" && path.endsWith("/claim"))        return "claimTask";
  if (method === "POST" && path.endsWith("/grant"))        return "grantTaskAccess";
  if (method === "POST" && path.endsWith("/release"))      return "releaseClaim";
  if (method === "POST")                                   return "createTask";
  return `${method}:${path}`;
}
