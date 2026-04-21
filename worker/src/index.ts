import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { verifyAndParse } from "./ingest";
import { persist } from "./persist";
import { scheduled as runScheduled } from "./cron";
import { routes as apiRoutes } from "./routes";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim());
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : allowed[0] ?? ""),
    allowHeaders: ["content-type", "authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 600,
  })(c, next);
});

app.get("/healthz", (c) => c.text("ok"));

app.post("/ingest", async (c) => {
  const parsed = await verifyAndParse(c.req.raw, c.env);
  if (parsed instanceof Response) return parsed;
  try {
    await persist(c.env, parsed.payload, parsed.rawBytes);
  } catch (e) {
    console.error("persist failed", e);
    return c.text("persist failed", 500);
  }
  return c.json({ ok: true });
});

app.route("/api", apiRoutes);

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await runScheduled(env);
  },
};
