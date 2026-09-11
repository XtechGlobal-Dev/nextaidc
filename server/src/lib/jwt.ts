import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";
import { env } from "../env.js";

export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: Role;
  permissions: string[];
  /** Tenant (brand) the account belongs to; null = the platform's own people.
   *  Every token minted now carries it — it says WHICH DATABASE the session is
   *  read from (`requireAuth`): a brand's own, or the control plane. Optional
   *  only so tokens minted before it existed still resolve, through the
   *  control plane's mirror row. */
  brandId?: string | null;
  /** Minted by admin impersonation rather than a real sign-in. Grants exactly the
   *  same access — it only lets us tell the two apart where "is this person really
   *  here?" matters (live presence), so an admin viewing an account never makes
   *  that customer look online. */
  imp?: boolean;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyToken(token: string): JwtPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload & { kind?: unknown };
  // A session token is minted only by signToken and never carries a `kind`.
  // Purpose-scoped tokens (unsubscribe, oauth_state) DO set `kind` and are signed
  // with the SAME secret — so without this guard jwt.verify would happily accept a
  // non-expiring unsubscribe link as a full login (account takeover). Reject
  // anything that isn't a real sign-in token. Mirror of the `kind` check that
  // verifyState/verifyUnsubscribe already do in the other direction.
  if (payload.kind !== undefined) {
    throw new Error("Not a session token");
  }
  return payload;
}

/**
 * Short-lived signed token carrying a user id — and the origin to come back to —
 * through an OAuth redirect round-trip.
 *
 * The return origin rides in the state because it CANNOT ride in the redirect
 * URI. Providers like Google demand an exact, pre-registered redirect_uri, so
 * every white-label tenant's consent flow has to come back through the one
 * canonical API host; the only way that host can know which brand's app to hand
 * the browser back to is to have been told, tamper-evidently, on the way out.
 *
 * Signing it is what makes that safe: `ret` decides where we 302 a freshly
 * authorised browser, so an attacker who could edit it would have an open
 * redirect out of an OAuth callback. The callback re-checks it against the
 * brand's real origins anyway (defence in depth) — but it must not be forgeable
 * in the first place.
 */
export function signState(userId: string, returnOrigin = ""): string {
  return jwt.sign({ sub: userId, kind: "oauth_state", ret: returnOrigin }, env.JWT_SECRET, {
    expiresIn: "10m",
  });
}

export function verifyState(token: string): { userId: string; returnOrigin: string } {
  const p = jwt.verify(token, env.JWT_SECRET) as {
    sub?: string;
    kind?: string;
    ret?: string;
  };
  if (p.kind !== "oauth_state") throw new Error("bad state");
  return { userId: p.sub as string, returnOrigin: p.ret ?? "" };
}

/** Non-expiring signed token identifying the recipient behind an email
 *  unsubscribe link. No expiry on purpose — an unsubscribe link must keep
 *  working however long after the email was sent. Only grants the ability to
 *  toggle that user's notification opt-out, nothing else. */
export function signUnsubscribe(userId: string): string {
  return jwt.sign({ sub: userId, kind: "unsubscribe" }, env.JWT_SECRET);
}

export function verifyUnsubscribe(token: string): string {
  const p = jwt.verify(token, env.JWT_SECRET) as { sub?: string; kind?: string };
  if (p.kind !== "unsubscribe") throw new Error("bad unsubscribe token");
  return p.sub as string;
}

/** Capability token for a single call's recording. The call-log id is a database
 *  key that shows up in API responses, logs and browser history, so it isn't a
 *  secret — using it as the sole gate on the public recording proxy let anyone
 *  who ever saw the id fetch the audio, forever. This carries the id inside a
 *  SIGNED token with an expiry instead, so a leaked link stops working and the
 *  id alone grants nothing. `expiresIn` is short for the owner's dashboard (a
 *  fresh one is minted per view) and longer for emailed/shared links. */
/** What a recording token names: the call, and the brand whose database it
 *  is in. The recording proxy is served from the platform's host for every
 *  brand, so the token has to say where to look. */
export interface RecordingClaim {
  callLogId: string;
  brandId: string;
}

export function signRecording(callLogId: string, brandId: string, expiresIn: string | number): string {
  return jwt.sign({ sub: callLogId, brandId, kind: "recording" }, env.JWT_SECRET, {
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
  });
}

export function verifyRecording(token: string): RecordingClaim {
  const p = jwt.verify(token, env.JWT_SECRET) as { sub?: string; brandId?: string; kind?: string };
  if (p.kind !== "recording" || !p.sub || !p.brandId) throw new Error("bad recording token");
  return { callLogId: p.sub, brandId: p.brandId };
}
