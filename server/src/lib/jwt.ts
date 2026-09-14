import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";
import { env } from "../env.js";

export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: Role;
  permissions: string[];
  /** Which database the session is read from (brand DB, or control plane when null). Optional only
   *  for tokens minted before it existed. */
  brandId?: string | null;
  /** Minted by admin impersonation. Same access; only used so an admin viewing an account never looks online. */
  imp?: boolean;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyToken(token: string): JwtPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload & { kind?: unknown };
  // Purpose-scoped tokens (unsubscribe, oauth_state) share the secret and set `kind`; without this a
  // non-expiring unsubscribe link would verify as a full login (account takeover).
  if (payload.kind !== undefined) {
    throw new Error("Not a session token");
  }
  return payload;
}

/** OAuth state carrying the user id and return origin. The origin rides here because Google needs one
 *  pre-registered redirect_uri; it's signed because `ret` decides the post-auth 302 (open-redirect risk). */
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

/** Unsubscribe token. No expiry on purpose (the link must always work); grants only the opt-out toggle. */
export function signUnsubscribe(userId: string): string {
  return jwt.sign({ sub: userId, kind: "unsubscribe" }, env.JWT_SECRET);
}

export function verifyUnsubscribe(token: string): string {
  const p = jwt.verify(token, env.JWT_SECRET) as { sub?: string; kind?: string };
  if (p.kind !== "unsubscribe") throw new Error("bad unsubscribe token");
  return p.sub as string;
}

// Recording tokens: the call-log id isn't secret (it's in logs and history), so gating the public
// proxy on it alone let anyone fetch the audio forever. Signed + expiring instead.
/** The call and the brand whose DB it's in — the proxy serves every brand from the platform host. */
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
