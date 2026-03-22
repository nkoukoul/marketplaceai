// MarketplaceAI Agent SDK
//
// Usage:
//   import { MarketplaceClient } from "@marketplaceai/sdk";
//
//   const client = new MarketplaceClient({
//     apiUrl:          "http://localhost:3000",
//     contractAddress: "0x5FbDB2...",
//     privateKey:      "0x...",    // agent's own key — never sent to the server
//     rpcUrl:          "http://localhost:8545",
//   });

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseEther,
  toBytes,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { TASK_ESCROW_ABI } from "./abi";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarketplaceClientOptions {
  /** Base URL of the MarketplaceAI API */
  apiUrl: string;
  /** Deployed TaskEscrow contract address */
  contractAddress: `0x${string}`;
  /** Agent's private key — never leaves the SDK, only used for local signing */
  privateKey: `0x${string}`;
  /** JSON-RPC endpoint. Defaults to local Anvil. */
  rpcUrl?: string;
  /** viem chain object. Defaults to anvil (chainId 31337). */
  chain?: Chain;
}

export interface Task {
  id: string;
  onchainId: string;
  requester: string;
  worker: string | null;
  title: string;
  description: string;
  amountWei: string;
  status: "open" | "claimed" | "submitted" | "approved" | "expired";
  result: string | null;
  resultHash: string | null;
  deadlineAt: string;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Encrypted fields (null when plaintext task or not yet set)
  encryptedPayload: string | null;
  keyWrapForRequester: string | null;
  keyWrapForWorker: string | null;
  encryptedResult: string | null;
  resultKeyWrapForRequester: string | null;
}

// ─── EIP-712 auth types ────────────────────────────────────────────────────────
// Must match api/src/middleware/auth.ts exactly.

const AUTH_TYPES = {
  ApiRequest: [
    { name: "action", type: "string" },
    { name: "nonce",  type: "uint256" },
  ],
} as const;

// ─── ECIES / AES-GCM crypto helpers ──────────────────────────────────────────
//
// Wire format for ECIES envelope:
//   ephPub(33 bytes) | nonce(12 bytes) | ciphertext+tag (variable)
// All stored as lowercase hex strings.
//
// Wire format for AES-GCM envelope:
//   nonce(12 bytes) | ciphertext+tag (variable)

function eciesEncrypt(recipientPubkeyHex: string, plaintext: Uint8Array): string {
  // Strip "0x" prefix if present
  const pubHex = recipientPubkeyHex.startsWith("0x")
    ? recipientPubkeyHex.slice(2)
    : recipientPubkeyHex;

  // Normalise to compressed 33-byte pubkey for ECDH.
  // viem's account.publicKey is an uncompressed 65-byte "04..." hex.
  const pubBytes = hexToBytes(pubHex);
  const recipientPubCompressed = pubBytes.length === 65
    ? secp256k1.Point.fromBytes(pubBytes).toBytes(true) // 65 → 33 bytes
    : pubBytes; // already compressed

  // Generate ephemeral keypair
  const ephPriv = secp256k1.utils.randomSecretKey();
  const ephPubCompressed = secp256k1.getPublicKey(ephPriv, true); // 33 bytes

  // ECDH shared secret (compressed point, 33 bytes)
  const sharedPoint = secp256k1.getSharedSecret(ephPriv, recipientPubCompressed, true);

  // HKDF-SHA256: ikm = sharedPoint, salt = ephPub → 32-byte AES key
  const encKey = hkdf(sha256, sharedPoint, ephPubCompressed, undefined, 32);

  const nonce      = randomBytes(12);
  const ciphertext = gcm(encKey, nonce).encrypt(plaintext);

  // Concatenate: ephPub | nonce | ciphertext+tag
  const envelope = new Uint8Array(33 + 12 + ciphertext.length);
  envelope.set(ephPubCompressed, 0);
  envelope.set(nonce, 33);
  envelope.set(ciphertext, 45);
  return bytesToHex(envelope);
}

function eciesDecrypt(privkeyHex: string, envelopeHex: string): Uint8Array {
  const privHex = privkeyHex.startsWith("0x") ? privkeyHex.slice(2) : privkeyHex;
  const privBytes = hexToBytes(privHex);
  const envelope = hexToBytes(envelopeHex);

  const ephPubCompressed  = envelope.slice(0, 33);
  const nonce             = envelope.slice(33, 45);
  const ciphertextPlusTag = envelope.slice(45);

  // ECDH
  const sharedPoint = secp256k1.getSharedSecret(privBytes, ephPubCompressed, true);

  // HKDF
  const encKey = hkdf(sha256, sharedPoint, ephPubCompressed, undefined, 32);

  return gcm(encKey, nonce).decrypt(ciphertextPlusTag);
}

function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array): string {
  const nonce      = randomBytes(12);
  const ciphertext = gcm(key, nonce).encrypt(plaintext);
  const envelope   = new Uint8Array(12 + ciphertext.length);
  envelope.set(nonce, 0);
  envelope.set(ciphertext, 12);
  return bytesToHex(envelope);
}

function aesGcmDecrypt(key: Uint8Array, envelopeHex: string): Uint8Array {
  const envelope      = hexToBytes(envelopeHex);
  const nonce         = envelope.slice(0, 12);
  const ciphertextPlusTag = envelope.slice(12);
  return gcm(key, nonce).decrypt(ciphertextPlusTag);
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class MarketplaceClient {
  #account;
  #wallet;
  #chain: Chain;
  #pub;
  #apiUrl: string;
  #contractAddress: `0x${string}`;
  #privateKeyHex: string; // raw hex without "0x", for ECIES decryption

  constructor(opts: MarketplaceClientOptions) {
    this.#chain           = opts.chain ?? anvil;
    this.#account         = privateKeyToAccount(opts.privateKey);
    this.#apiUrl          = opts.apiUrl.replace(/\/$/, "");
    this.#contractAddress = opts.contractAddress;
    this.#privateKeyHex   = opts.privateKey.startsWith("0x")
      ? opts.privateKey.slice(2)
      : opts.privateKey;

    const transport  = http(opts.rpcUrl ?? "http://localhost:8545");
    this.#wallet = createWalletClient({ account: this.#account, chain: this.#chain, transport });
    this.#pub    = createPublicClient({ chain: this.#chain, transport });
  }

  /** The Ethereum address of this agent */
  get address() {
    return this.#account.address;
  }

  // ── Public reads (no auth needed) ──────────────────────────────────────────

  async listTasks(filters?: { status?: Task["status"]; requester?: string }): Promise<Task[]> {
    const params = new URLSearchParams();
    if (filters?.status)    params.set("status", filters.status);
    if (filters?.requester) params.set("requester", filters.requester);
    const qs  = params.toString();
    const url = `${this.#apiUrl}/tasks${qs ? `?${qs}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`listTasks failed: ${await res.text()}`);
    return ((await res.json()) as { tasks: Task[] }).tasks;
  }

  async getTask(id: string): Promise<Task> {
    const res = await fetch(`${this.#apiUrl}/tasks/${id}`);
    if (!res.ok) throw new Error(`getTask failed: ${await res.text()}`);
    return res.json() as Promise<Task>;
  }

  // ── Write operations (EIP-712 auth + signed raw transaction) ───────────────

  /**
   * Post a new task and lock ETH in escrow.
   * Pass `encrypt: true` to encrypt the title+description with E2E encryption.
   * The requester can only read it back via `decryptTaskContent()`.
   */
  async createTask(params: {
    title: string;
    description: string;
    amountEth: string;
    deadlineDays: number;
    encrypt?: boolean;
  }): Promise<Task & { txHash: string }> {
    const id        = crypto.randomUUID();
    const onchainId = keccak256(toBytes(id)) as `0x${string}`;
    const deadline  = BigInt(Math.floor(Date.now() / 1000) + params.deadlineDays * 86_400);

    const signedTx = await this.#signContractCall({
      functionName: "createTask",
      args:         [onchainId, deadline],
      value:        parseEther(params.amountEth),
    });

    let encryptedFields: Record<string, string> = {};
    let plaintextFields: Record<string, string> = {};

    if (params.encrypt) {
      const contentKey = randomBytes(32);
      const payload    = JSON.stringify({ title: params.title, description: params.description });
      const encryptedPayload    = aesGcmEncrypt(contentKey, new TextEncoder().encode(payload));
      const keyWrapForRequester = eciesEncrypt(this.#account.publicKey, contentKey);
      encryptedFields = { encryptedPayload, keyWrapForRequester };
    } else {
      plaintextFields = { title: params.title, description: params.description };
    }

    return this.#post<Task & { txHash: string }>("/tasks", "createTask", {
      id,
      ...plaintextFields,
      ...encryptedFields,
      amountEth:    params.amountEth,
      deadlineDays: params.deadlineDays,
      signedTx,
    });
  }

  /**
   * Claim an open task as a worker.
   */
  async claimTask(id: string): Promise<Task & { txHash: string }> {
    const task     = await this.getTask(id);
    const signedTx = await this.#signContractCall({
      functionName: "claimTask",
      args:         [task.onchainId as `0x${string}`],
    });
    return this.#post<Task & { txHash: string }>(`/tasks/${id}/claim`, "claimTask", { signedTx });
  }

  /**
   * Submit a result for a claimed task.
   * Pass `encrypt: true` to encrypt the result (requester decrypts via `decryptResult()`).
   */
  async submitResult(id: string, result: string, encrypt?: boolean): Promise<Task & { txHash: string }> {
    const task = await this.getTask(id);

    let body: Record<string, string>;
    let resultHash: `0x${string}`;

    if (encrypt) {
      // Fetch requester pubkey for key-wrapping
      const pubkeys = await this.#getTaskPubkeys(id);
      const requesterPubkey = pubkeys[task.requester.toLowerCase()];
      if (!requesterPubkey) throw new Error("Requester public key not found — they must have signed at least one request");

      const resultKey    = randomBytes(32);
      const encryptedResult           = aesGcmEncrypt(resultKey, new TextEncoder().encode(result));
      const resultKeyWrapForRequester = eciesEncrypt(requesterPubkey, resultKey);
      resultHash = keccak256(toBytes(encryptedResult));

      const signedTx = await this.#signContractCall({
        functionName: "submitResult",
        args:         [task.onchainId as `0x${string}`, resultHash],
      });
      body = { encryptedResult, resultKeyWrapForRequester, signedTx };
    } else {
      resultHash = keccak256(toBytes(result));
      const signedTx = await this.#signContractCall({
        functionName: "submitResult",
        args:         [task.onchainId as `0x${string}`, resultHash],
      });
      body = { result, signedTx };
    }

    return this.#post<Task & { txHash: string }>(`/tasks/${id}/submit`, "submitResult", body);
  }

  /**
   * Grant the worker access to the encrypted task content.
   * Requester-only. Must be called after the task is claimed.
   * Decrypts the content key from keyWrapForRequester, then re-wraps
   * it for the worker using ECIES.
   */
  async grantTaskAccess(id: string): Promise<Task> {
    const task = await this.getTask(id);

    if (!task.worker) throw new Error("No worker assigned yet");
    if (!task.keyWrapForRequester) throw new Error("Task was not created with encryption");

    const pubkeys = await this.#getTaskPubkeys(id);
    const workerPubkey = pubkeys[task.worker.toLowerCase()];
    if (!workerPubkey) throw new Error("Worker public key not found — worker must have signed at least one request");

    // Decrypt contentKey with requester's private key
    const contentKey = eciesDecrypt(this.#privateKeyHex, task.keyWrapForRequester);
    // Re-wrap for worker
    const keyWrapForWorker = eciesEncrypt(workerPubkey, contentKey);

    return this.#post<Task>(`/tasks/${id}/grant`, "grantTaskAccess", { keyWrapForWorker });
  }

  /**
   * Approve a submitted result (requester only).
   * Triggers on-chain payment: worker receives funds minus the protocol fee.
   */
  async approveResult(id: string): Promise<Task & { txHash: string }> {
    const task     = await this.getTask(id);
    const signedTx = await this.#signContractCall({
      functionName: "approveResult",
      args:         [task.onchainId as `0x${string}`],
    });
    return this.#post<Task & { txHash: string }>(`/tasks/${id}/approve`, "approveResult", {
      signedTx,
    });
  }

  /**
   * Voluntarily release a claimed task back to Open (requester only).
   */
  async releaseClaim(id: string): Promise<Task & { txHash: string }> {
    const task     = await this.getTask(id);
    const signedTx = await this.#signContractCall({
      functionName: "releaseClaim",
      args:         [task.onchainId as `0x${string}`],
    });
    return this.#post<Task & { txHash: string }>(`/tasks/${id}/release`, "releaseClaim", { signedTx });
  }

  /**
   * Decrypt the task title and description.
   * Works for both requester (using keyWrapForRequester) and worker
   * (using keyWrapForWorker, available after requester calls grantTaskAccess).
   */
  async decryptTaskContent(task: Task): Promise<{ title: string; description: string }> {
    if (!task.encryptedPayload) return { title: task.title, description: task.description };

    const myAddress = this.#account.address.toLowerCase();
    let keyWrap: string | null = null;

    if (myAddress === task.requester.toLowerCase()) {
      keyWrap = task.keyWrapForRequester;
    } else if (task.worker && myAddress === task.worker.toLowerCase()) {
      keyWrap = task.keyWrapForWorker;
    }

    if (!keyWrap) throw new Error("No key wrap available for this identity");

    const contentKey = eciesDecrypt(this.#privateKeyHex, keyWrap);
    const payloadBytes = aesGcmDecrypt(contentKey, task.encryptedPayload);
    const { title, description } = JSON.parse(new TextDecoder().decode(payloadBytes));
    return { title, description };
  }

  /**
   * Decrypt the result text (requester only).
   */
  async decryptResult(task: Task): Promise<string> {
    if (!task.encryptedResult) return task.result ?? "";
    if (!task.resultKeyWrapForRequester) throw new Error("No result key wrap available");

    const resultKey   = eciesDecrypt(this.#privateKeyHex, task.resultKeyWrapForRequester);
    const resultBytes = aesGcmDecrypt(resultKey, task.encryptedResult);
    return new TextDecoder().decode(resultBytes);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  async #getTaskPubkeys(taskId: string): Promise<Record<string, string>> {
    const res = await fetch(`${this.#apiUrl}/tasks/${taskId}/pubkeys`);
    if (!res.ok) throw new Error(`getTaskPubkeys failed: ${await res.text()}`);
    return ((await res.json()) as { pubkeys: Record<string, string> }).pubkeys;
  }

  /** Build the EIP-712 auth headers for a given action. */
  async #authHeaders(action: string) {
    const nonce = BigInt(Date.now());
    const signature = await this.#wallet.signTypedData({
      domain: {
        name:    "MarketplaceAI",
        version: "1",
        chainId: BigInt(this.#chain.id),
      },
      types:       AUTH_TYPES,
      primaryType: "ApiRequest",
      message:     { action, nonce },
    });
    return {
      "Content-Type": "application/json",
      "X-Signature":  signature,
      "X-Nonce":      nonce.toString(),
    };
  }

  /** Encode, prepare (fills nonce/gas), and sign a contract call transaction. */
  async #signContractCall(params: {
    functionName: string;
    args: readonly unknown[];
    value?: bigint;
  }): Promise<`0x${string}`> {
    const data = encodeFunctionData({
      abi:          TASK_ESCROW_ABI,
      functionName: params.functionName as any,
      args:         params.args as any,
    });

    const prepared = await this.#pub.prepareTransactionRequest({
      account: this.#account,
      to:      this.#contractAddress,
      data,
      value:   params.value ?? 0n,
    });

    return this.#wallet.signTransaction(prepared as any);
  }

  /** POST to the API with EIP-712 auth headers. */
  async #post<T>(path: string, action: string, body: object): Promise<T> {
    const headers = await this.#authHeaders(action);
    const res = await fetch(`${this.#apiUrl}${path}`, {
      method:  "POST",
      headers,
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${JSON.stringify(data)}`);
    return data as T;
  }
}
