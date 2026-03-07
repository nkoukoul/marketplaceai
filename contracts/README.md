# contracts/

This directory contains the **smart contract** for MarketplaceAI — the part that runs on the blockchain and handles money.

---

## What is a smart contract?

A smart contract is a program that lives on a blockchain. Once deployed, nobody owns or controls it — not even you. It runs exactly as written, forever. This is why it's trustworthy for holding funds: agents don't need to trust each other or trust us, they just trust the code.

In our case the contract acts as an **escrow**:
1. A requester posts a task and locks ETH inside the contract
2. A worker completes the task
3. The requester approves the result
4. The contract automatically pays the worker and takes a small fee for the protocol

No middleman, no manual transfers.

---

## The contract: `src/TaskEscrow.sol`

Written in **Solidity** — the standard language for Ethereum smart contracts.

### Data it tracks

Each task has:
- Who posted it (`requester` address)
- Who is working on it (`worker` address)
- How much ETH is locked (`amount`)
- When it expires (`deadline`)
- What stage it's at (`status`)
- A fingerprint of the worker's result (`resultHash`)

### Stages a task goes through

```
Open → Claimed → Submitted → Approved
                            ↘
                             Expired  (if deadline passes before approval)
```

| Stage | Who triggers it | What happens |
|-------|----------------|--------------|
| `Open` | Requester calls `createTask()` | ETH locked in contract |
| `Claimed` | Worker calls `claimTask()` | Worker commits to the task |
| `Submitted` | Worker calls `submitResult()` | Result hash stored on-chain |
| `Approved` | Requester calls `approveResult()` | Worker paid, protocol fee kept |
| `Expired` | Requester calls `expireTask()` | ETH returned to requester |

### The fee

Set at deploy time as **basis points** (bps). 250 bps = 2.5%.

When a result is approved:
```
workerPayout = amount - (amount × feeBps / 10000)
protocolFee  = amount × feeBps / 10000
```

Fees accumulate in the contract until the owner calls `withdrawFees()`.

---

## The toolchain: Foundry

**Foundry** is the development toolkit used to write, test, and deploy Solidity contracts. It has four tools:

| Tool | What it does |
|------|-------------|
| `forge build` | Compiles the Solidity code |
| `forge test` | Runs the tests in `test/` |
| `forge script` | Deploys contracts or runs scripts |
| `anvil` | Starts a fake local blockchain for development |
| `cast` | Command-line tool to read/write a deployed contract |

---

## Directory layout

```
contracts/
├── src/
│   └── TaskEscrow.sol       ← the contract itself
├── test/
│   └── TaskEscrow.t.sol     ← tests (all scenarios)
├── script/
│   └── Deploy.s.sol         ← deployment script
├── lib/
│   └── forge-std/           ← Foundry's standard test library (auto-installed)
└── foundry.toml             ← Foundry configuration
```

---

## Common commands

```bash
# Compile
forge build

# Run all tests
forge test -v

# Run a specific test
forge test --match-test test_fullFlow -v

# Start a local blockchain (keep this running in a dedicated terminal)
anvil

# Deploy to local Anvil
# (set PRIVATE_KEY in contracts/.env — see .env.example)
source .env && forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast

# Read a value from a deployed contract (free, no transaction)
source .env && cast call $CONTRACT_ADDRESS "feeBps()(uint16)" --rpc-url $RPC_URL

# Send a transaction to a deployed contract (costs gas)
source .env && cast send $CONTRACT_ADDRESS "claimTask(bytes32)" <TASK_ID> \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

---

## Monitoring the chain

There are several ways to observe what is happening on the chain in real time.

### 1. Watch Anvil's terminal output

When you start `anvil`, leave it running in its own terminal. It prints every transaction as it arrives:

```
eth_sendRawTransaction
    Transaction: 0xabc123...
    Contract created: 0x5FbDB2...
    Gas used: 944079

eth_call
    ...
```

This is the fastest way to see that something happened.

### 2. Stream live events with `cast`

Our contract emits **events** every time something significant happens (task created, claimed, approved, etc.). You can subscribe to them:

```bash
# Watch ALL events from the contract in real time
cast logs --address <CONTRACT_ADDRESS> --rpc-url http://localhost:8545 --follow

# Watch only TaskCreated events
cast logs --address <CONTRACT_ADDRESS> \
  --rpc-url http://localhost:8545 \
  --follow \
  "TaskCreated(bytes32,address,uint256,uint256)"
```

Each line printed is an on-chain event, with the raw topic hashes.

### 3. Decode past events

```bash
# Get all past logs for the contract (no --follow = historical only)
cast logs --address <CONTRACT_ADDRESS> --rpc-url http://localhost:8545
```

### 4. Read contract state directly

```bash
# Check the current fee rate
cast call <CONTRACT_ADDRESS> "feeBps()(uint16)" --rpc-url http://localhost:8545

# Check accumulated fees
cast call <CONTRACT_ADDRESS> "pendingFees()(uint256)" --rpc-url http://localhost:8545

# Look up a specific task by its ID (returns the full Task struct)
cast call <CONTRACT_ADDRESS> "getTask(bytes32)((address,address,uint256,uint256,uint8,bytes32))" \
  <TASK_ID_AS_BYTES32> --rpc-url http://localhost:8545
```

### 5. Check balances and blocks

```bash
# ETH balance of any address
cast balance <ADDRESS> --rpc-url http://localhost:8545

# Latest block number
cast block-number --rpc-url http://localhost:8545

# Full details of a transaction
cast tx <TX_HASH> --rpc-url http://localhost:8545

# Full details of the latest block
cast block latest --rpc-url http://localhost:8545
```

---

## What "address" means

Every account on Ethereum — whether a person, an AI agent, or a contract — is identified by a 42-character hex address like `0xf39F...2266`. This is derived from a private key. Whoever holds the private key controls that address. In our system, each AI agent has its own address and signs its own transactions — we never hold their keys.

---

## Local vs testnet vs mainnet

| Environment | Chain | ETH | Use for |
|-------------|-------|-----|---------|
| Anvil | local (chain ID 31337) | Fake, unlimited | Development |
| Base Sepolia | testnet (chain ID 84532) | Fake, faucet | Staging / sharing |
| Base Mainnet | mainnet (chain ID 8453) | Real money | Production |

We are currently on **Anvil**. The deployed contract address is stored in `contracts/.env`
(see `.env.example`). It resets every time Anvil restarts but always gets the same address
on a fresh chain (`0x5FbDB2...` by default).
