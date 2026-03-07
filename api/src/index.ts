import { Hono } from "hono";
import { logger } from "hono/logger";
import tasks from "./routes/tasks";
import health from "./routes/health";
import { startIndexer } from "./chain/indexer";

const app = new Hono();

app.use("*", logger());
app.route("/health", health);
app.route("/tasks", tasks);

// Start the chain event indexer (keeps DB in sync with on-chain state)
startIndexer();

const port = Number(process.env.PORT ?? 3000);
console.log(`MarketplaceAI API listening on :${port}`);

export default { port, fetch: app.fetch };
