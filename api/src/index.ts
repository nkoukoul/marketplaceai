import { Hono } from "hono";
import { logger } from "hono/logger";
import tasks from "./routes/tasks";
import health from "./routes/health";
import { startIndexer } from "./chain/indexer";
import { startAutoApproveJob } from "./chain/autoApproveJob";

const app = new Hono();

app.use("*", logger());
app.route("/health", health);
app.route("/tasks", tasks);

// Keep DB in sync with on-chain events
startIndexer();

// Trigger autoApprove() for submitted tasks past their window
startAutoApproveJob();

const port = Number(process.env.PORT ?? 3000);
console.log(`MarketplaceAI API listening on :${port}`);

export default { port, fetch: app.fetch };
