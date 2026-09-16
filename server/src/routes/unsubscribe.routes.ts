import { Router } from "express";
import { planeOf } from "../services/tenantDb.js";
import { brandIdForOwner } from "../services/customerDirectory.js";
import { asyncHandler } from "../lib/http.js";
import { verifyUnsubscribe } from "../lib/jwt.js";
import { escapeHtml } from "../lib/escapeHtml.js";
import { emailGlobals } from "../services/emailTemplates.js";

// Public (no-auth) email unsubscribe: footer link + RFC 8058 one-click. Toggles
// User.emailOptOutAt and renders a self-contained page (no SPA needed).

const router = Router();

/** Resolve the user id from the signed token, or null if it's missing/invalid. */
async function userFromToken(token: unknown): Promise<{ id: string; email: string } | null> {
  if (typeof token !== "string" || !token) return null;
  try {
    const userId = verifyUnsubscribe(token);
    // Whichever plane the account lives in — a brand's database, or Main.
    const db = await planeOf(await brandIdForOwner(userId));
    return await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  } catch {
    return null;
  }
}

function page(title: string, bodyHtml: string): string {
  const { app_name } = emailGlobals();
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)} · ${escapeHtml(app_name)}</title></head>` +
    `<body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">` +
    `<div style="max-width:480px;margin:64px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:40px 32px;text-align:center">` +
    `<div style="font-size:20px;font-weight:700;margin-bottom:20px">${escapeHtml(app_name)}</div>` +
    bodyHtml +
    `</div></body></html>`
  );
}

/** Set (or clear) the recipient's notification opt-out. Idempotent. */
async function setOptOut(userId: string, optOut: boolean): Promise<void> {
  await (await planeOf(await brandIdForOwner(userId))).user.update({
    where: { id: userId },
    // Prisma is fine with `new Date()` here; scripts-runtime restrictions don't apply to server code.
    data: { emailOptOutAt: optOut ? new Date() : null },
  });
}

// RFC 8058 one-click: mail providers POST here, no browser. Always 200 on a valid
// token so the provider marks it done.
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const user = await userFromToken(req.query.token);
    if (!user) {
      res.status(400).type("text/plain").send("Invalid or expired unsubscribe link.");
      return;
    }
    await setOptOut(user.id, true);
    res.status(200).type("text/plain").send("You have been unsubscribed.");
  }),
);

// Human-facing: `?token=` opts out, `?token=&resubscribe=1` opts back in.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = await userFromToken(req.query.token);
    if (!user) {
      res
        .status(400)
        .type("text/html")
        .send(
          page(
            "Link expired",
            `<p style="font-size:15px;line-height:1.6;color:#52525b;margin:0">` +
              `This unsubscribe link is invalid or has expired. If you're still receiving unwanted emails, ` +
              `please contact support.</p>`,
          ),
        );
      return;
    }

    const resubscribe = req.query.resubscribe === "1";
    await setOptOut(user.id, !resubscribe);
    const token = encodeURIComponent(String(req.query.token));
    const email = escapeHtml(user.email);

    const body = resubscribe
      ? `<p style="font-size:15px;line-height:1.6;color:#52525b;margin:0 0 8px"><strong>You're subscribed again.</strong></p>` +
        `<p style="font-size:14px;line-height:1.6;color:#71717a;margin:0">` +
        `${email} will keep receiving notification emails such as call summaries and usage alerts.</p>`
      : `<p style="font-size:15px;line-height:1.6;color:#52525b;margin:0 0 8px"><strong>You've been unsubscribed.</strong></p>` +
        `<p style="font-size:14px;line-height:1.6;color:#71717a;margin:0 0 24px">` +
        `${email} will no longer receive notification emails (call summaries, usage and trial reminders). ` +
        `You'll still get important account and security emails.</p>` +
        `<a href="/api/unsubscribe?token=${token}&resubscribe=1" ` +
        `style="display:inline-block;font-size:14px;color:#2563eb;text-decoration:none">` +
        `Changed your mind? Re-subscribe</a>`;

    res.status(200).type("text/html").send(page(resubscribe ? "Subscribed" : "Unsubscribed", body));
  }),
);

export default router;
