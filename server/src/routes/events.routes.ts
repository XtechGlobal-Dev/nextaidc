import { Router } from "express";
import { verifyToken } from "../lib/jwt.js";
import { planeOf } from "../services/tenantDb.js";
import { addClient, removeClient } from "../services/events.js";
import { isAdminTeamRole } from "../lib/roles.js";

const router = Router();

// SSE stream. EventSource can't set headers, so the JWT rides in `?token=`; we
// verify it and confirm the user still exists (same as requireAuth).
router.get("/stream", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) {
    res.status(401).end();
    return;
  }

  let sub: string;
  let role: string;
  let impersonated = false;
  try {
    const payload = verifyToken(token);
    // The account lives in the plane the token names: a brand's database, or Main.
    const user = await (await planeOf(payload.brandId ?? null)).user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true },
    });
    if (!user) {
      res.status(401).end();
      return;
    }
    sub = user.id;
    role = user.role;
    // An admin viewing this account: still gets the customer's live updates, but
    // must not register as the customer being online.
    impersonated = payload.imp === true;
  } catch {
    res.status(401).end();
    return;
  }

  // SSE headers. `X-Accel-Buffering: no` disables proxy buffering (nginx/Render)
  // so events flush immediately instead of being held back.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Ask the browser to wait 5s before reconnecting after a drop.
  res.write("retry: 5000\n\n");
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  // Every user listens on their own channel; admins/staff also get the shared
  // "admin" channel so aggregate dashboards refresh on any customer's activity.
  const channels = [`user:${sub}`];
  if (isAdminTeamRole(role)) channels.push("admin");
  const clientId = addClient(res, channels, { impersonated });

  let heartbeat: ReturnType<typeof setInterval>;
  // Idempotent (clearInterval + Map.delete both tolerate repeats), so every
  // disconnect signal below can call it without guarding.
  const cleanup = () => {
    clearInterval(heartbeat);
    removeClient(clientId);
  };

  // Heartbeat also reaps dead clients: a half-open socket never fires 'close' and
  // res.write() doesn't throw on it, so check it's alive or the user shows "online" forever.
  heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed || res.socket === null || res.socket.destroyed) {
      cleanup();
      return;
    }
    try {
      res.write(": ping\n\n");
    } catch {
      cleanup();
    }
  }, 25_000);

  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("error", cleanup);
});

export default router;
