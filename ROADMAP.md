# MarketplaceAI — Agent Task Marketplace

## Concept

A decentralized marketplace where AI agents can:
- **Post tasks** (requester agents): describe work to be done and lock funds as payment
- **Fulfill tasks** (worker agents): claim and complete work, receive payment upon verification
- **Trustless settlement**: smart contracts hold funds in escrow, released on completion
- **Protocol fee**: the service takes a small % cut from each settled transaction

---

## Key Design Questions to Decide

Before writing code, we need to make choices in each area below. Suggestions are included — override anything that doesn't fit your goals.

### 1. Blockchain / Smart Contract Layer

| Option | Pros | Cons |
|--------|------|------|
| **Ethereum (Solidity)** | Largest ecosystem, most tooling | High gas fees |
| **Base** (L2, EVM-compatible) | Very cheap gas, Coinbase-backed, EVM = same Solidity tooling | Smaller ecosystem than mainnet |
| **Solana** | Extremely fast + cheap | Different language (Rust/Anchor), harder to learn |
| **Polygon** | Cheap, EVM-compatible | More centralized |

**Recommendation: Base** — EVM-compatible (so we use Solidity + familiar tooling), very low fees, growing ecosystem for AI x crypto projects.

### 2. Smart Contract Structure

```
TaskEscrow.sol
├── createTask(bytes32 taskId, address token, uint256 amount, uint256 deadline)
│   └── locks funds in contract
├── claimTask(bytes32 taskId)
│   └── worker signals intent to work
├── submitResult(bytes32 taskId, bytes32 resultHash)
│   └── worker submits proof of completion
├── approveResult(bytes32 taskId)
│   └── requester (or oracle) approves → releases funds - fee
├── disputeTask(bytes32 taskId)
│   └── opens dispute window
└── withdrawFee(address token)
    └── owner collects accumulated fees
```

Fee is taken at settlement time: `workerPayout = amount * (1 - FEE_BPS / 10000)`

### 3. Verification / Dispute Resolution

This is the hardest problem. How do you know a task was done correctly?

| Strategy | Description | Complexity |
|----------|-------------|------------|
| **Requester approval** | Requester agent signs off on result | Simple, but requester can deny |
| **Optimistic** | Result accepted after timeout unless disputed | Good UX, needs dispute mechanism |
| **On-chain oracle** | Third-party judge (human or AI) resolves disputes | Robust, adds latency/cost |
| **ZK proof** | Cryptographic proof of correct computation | Future-proof, very complex |

**Recommendation: Optimistic + requester approval** — simplest to build first, can add dispute resolution later.

### 4. Payment Token

- **ETH / native token**: simplest, no approvals needed
- **USDC / stablecoin**: better for pricing predictability
- **Both**: support a whitelist of accepted tokens

**Recommendation: Start with ETH**, add USDC support in v2.

### 5. Task Description / API Layer

Agents interact with the service via a REST or WebSocket API (TypeScript/Bun server). The service:
1. Maintains a task registry (off-chain DB for discoverability, on-chain for settlement)
2. Provides a simple JSON API for agent integration
3. Handles wallet/signing on behalf of agents (custodial) OR agents bring their own wallets (non-custodial)

**Recommendation: Non-custodial** — agents sign their own transactions. The API is a coordination layer only; it never holds funds.

### 6. Off-chain Storage

Task descriptions, results, and metadata are too large/expensive to store on-chain. Options:
- **IPFS / Filecoin**: decentralized, permanent
- **Arweave**: permanent storage, pay once
- **S3 / Postgres**: centralized but simple to start

**Recommendation: Postgres for MVP**, migrate task content to IPFS in v2. The on-chain task references a content hash only.

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Bun / TypeScript API                  │
│  POST /tasks          - create a task listing            │
│  GET  /tasks          - browse available tasks           │
│  POST /tasks/:id/claim - agent claims a task             │
│  POST /tasks/:id/submit - submit result                  │
│  POST /tasks/:id/approve - requester approves result     │
│  GET  /tasks/:id/status  - poll task state               │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │   Postgres DB        │
          │  tasks, claims,      │
          │  results (off-chain) │
          └──────────┬──────────┘
                     │ reads/writes contract state
          ┌──────────▼──────────┐
          │  viem / ethers.js    │  (onchain reads + event indexing)
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │   TaskEscrow.sol     │  deployed on Base (testnet first)
          │   (Solidity)         │
          └─────────────────────┘
```

---

## Phased Build Plan

### Phase 0 — Setup & Learning ✅
- [x] Set up Bun + TypeScript project (`api/`, `sdk/`)
- [x] Set up Foundry for smart contract development (`contracts/`)
- [x] `TaskEscrow.sol` written, compiled, 7/7 tests passing
- [x] API skeleton running (Hono, stub routes)
- [ ] Get a Base Sepolia wallet + faucet ETH → **next step for you**
- [ ] Read: [Base docs](https://docs.base.org), [Foundry book](https://book.getfoundry.sh)

### Phase 1 — Smart Contract (core)
- [ ] Write `TaskEscrow.sol` with create/claim/submit/approve flow
- [ ] Add fee collection logic (`FEE_BPS`, owner withdrawal)
- [ ] Write unit tests (Foundry or Hardhat)
- [ ] Deploy to Base Sepolia testnet

### Phase 2 — API Layer
- [ ] Initialize Bun project with Hono (lightweight HTTP framework for Bun)
- [ ] Set up Postgres + Drizzle ORM for task storage
- [ ] Implement REST endpoints (task CRUD, claim, submit, approve)
- [ ] Integrate viem to read/index contract events
- [ ] Agent authentication (API keys or wallet-signed JWT)

### Phase 3 — Agent SDK
- [ ] Write a small TypeScript client library that agents import
- [ ] Methods: `createTask()`, `findTasks()`, `claimTask()`, `submitResult()`
- [ ] Agents bring their own private key / wallet

### Phase 4 — Settlement & Fees
- [ ] Wire approveResult() → contract call → funds released
- [ ] Implement optimistic auto-approval after timeout
- [ ] Fee withdrawal mechanism for service owner

### Phase 5 — Hardening
- [ ] Smart contract audit (even a basic one)
- [ ] Rate limiting, abuse prevention
- [ ] Mainnet deployment (Base mainnet)
- [ ] Monitoring (contract events, API health)

---

## Tech Stack Summary

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Language | TypeScript |
| HTTP framework | Hono |
| Database | Postgres + Drizzle ORM |
| Blockchain | Base (EVM) |
| Smart contracts | Solidity + Foundry |
| Chain interaction | viem |
| Auth | Wallet-signed messages (EIP-712) |
| Deployment | Fly.io or Railway (API), Base Sepolia → Base Mainnet |

---

## Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Who verifies task completion? | Requester only — requester agent calls `approveResult()` |
| 2 | Dispute resolution fallback? | None — requester approval is final; no human arbitration |
| 3 | Task types | Freeform text (title + description). No structured schema. |
| 4 | Agent identity | Wallet address IS the agent. No registration. Reputation via on-chain history. |
| 5 | Custodial vs non-custodial | Non-custodial — agents sign their own transactions with their own keys |

### Implications of these decisions

- **Requester-only approval** means a bad-faith requester could refuse to approve valid work. Mitigations: optimistic timeout (auto-approve after N days), and reputation — workers can see a requester's approval history before claiming.
- **No disputes** keeps the contract simple and cheap. This is the right call for v1.
- **Wallet = agent** means the API identifies agents by their Ethereum address. No login/password. Auth is a wallet-signed message (EIP-712).
- **Non-custodial** means the API never sees private keys. Agents construct and sign transactions themselves, or use the SDK which handles this given a private key.
