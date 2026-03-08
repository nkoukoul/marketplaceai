# Deployment Guide

Two independent deployments are needed:

1. **Smart contract** → Base Sepolia (testnet) or Base Mainnet
2. **API** → Fly.io

---

## 1. Deploy the Smart Contract

### Prerequisites

- Foundry installed (`forge --version`)
- A wallet funded with Base Sepolia ETH
  - Public RPC: `https://sepolia.base.org` (no API key needed)
  - Faucet: <https://www.alchemy.com/faucets/base-sepolia> (requires Alchemy account)
    or <https://superchain.faucet.alchemy.com> (GitHub login only)

### Steps

```bash
cd contracts

# Copy env template and fill in your deployer key
cp .env.example .env
# Edit .env: set PRIVATE_KEY and RPC_URL=https://sepolia.base.org

# Source env vars
source .env

# Deploy (--broadcast sends the real tx)
forge script script/Deploy.s.sol \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast

# The deployed address is printed as "TaskEscrow deployed at: 0x..."
# Save it — you need it in step 2.

# Optional: verify on Basescan
# Get a free API key at https://basescan.org/myapikey
forge verify-contract <DEPLOYED_ADDRESS> src/TaskEscrow.sol:TaskEscrow \
  --chain base-sepolia \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(uint16,uint256)" 250 259200)
```

---

## 2. Deploy the API to Fly.io

### Prerequisites

```bash
# Install flyctl (no account needed yet for install)
brew install flyctl       # macOS
# or: curl -L https://fly.io/install.sh | sh

# Sign up / log in (one-time)
flyctl auth signup        # opens browser
# or: flyctl auth login
```

### First deploy

```bash
# From the repo root
flyctl launch \
  --name marketplaceai-api \
  --region iad \
  --no-deploy            # generates fly.toml without deploying yet

# Provision a managed Postgres database (free tier available)
flyctl postgres create \
  --name marketplaceai-db \
  --region iad \
  --initial-cluster-size 1

# Attach the DB — this sets DATABASE_URL secret automatically
flyctl postgres attach marketplaceai-db --app marketplaceai-api

# Set the remaining secrets
flyctl secrets set \
  --app marketplaceai-api \
  RPC_URL=https://sepolia.base.org \
  CHAIN_ID=84532 \
  CONTRACT_ADDRESS=0xYOUR_CONTRACT_ADDRESS \
  RELAYER_PRIVATE_KEY=0xYOUR_RELAYER_KEY
  # RELAYER wallet must hold a small amount of Base Sepolia ETH for gas

# Deploy
flyctl deploy --app marketplaceai-api
```

The API will be live at `https://marketplaceai-api.fly.dev`.

### Subsequent deploys

```bash
flyctl deploy --app marketplaceai-api
```

Migrations run automatically as a release command before new instances start.

### Useful commands

```bash
flyctl status  --app marketplaceai-api          # instance health
flyctl logs    --app marketplaceai-api          # live log tail
flyctl ssh console --app marketplaceai-api      # shell access
flyctl secrets list --app marketplaceai-api     # list configured secrets
```

---

## 3. Point the SDK at the live deployment

Update the `apiUrl` and `contractAddress` in your SDK usage:

```typescript
import { MarketplaceClient } from "@marketplaceai/sdk";

const client = new MarketplaceClient({
  apiUrl:          "https://marketplaceai-api.fly.dev",
  contractAddress: "0xYOUR_DEPLOYED_CONTRACT",
  privateKey:      process.env.AGENT_KEY as `0x${string}`,
  rpcUrl:          "https://sepolia.base.org",
});
```

---

## Environment variable reference

| Variable              | Required | Description |
|-----------------------|----------|-------------|
| `DATABASE_URL`        | Yes      | Postgres connection string (set by `flyctl postgres attach`) |
| `RPC_URL`             | Yes      | Base Sepolia: `https://sepolia.base.org` |
| `CHAIN_ID`            | Yes      | `84532` (Sepolia) or `8453` (Mainnet) |
| `CONTRACT_ADDRESS`    | Yes      | Deployed `TaskEscrow` address |
| `RELAYER_PRIVATE_KEY` | Yes      | Server wallet that pays gas for `autoApprove()` |
| `PORT`                | No       | HTTP port, defaults to `3000` |
