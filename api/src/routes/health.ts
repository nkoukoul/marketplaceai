import { Hono } from "hono";

const health = new Hono();

health.get("/", (c) => c.json({ status: "ok", service: "marketplaceai-api" }));

export default health;
