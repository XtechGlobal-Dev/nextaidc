import bcrypt from "bcryptjs";
import { prisma } from "../prisma.js";

/**
 * The PIN that gates "Login as Customer".
 *
 * Impersonation is the most powerful thing an admin can do — it hands over a
 * real session as somebody else — so it is worth a second factor beyond "this
 * browser is logged in as an admin". The obvious case it defends is an admin
 * who walks away from an unlocked machine.
 *
 * WHAT THIS IS NOT: the UI hides the entry point behind an emoji, and that is
 * worth nothing on its own. `POST /customers/:id/impersonate` is still a
 * documented endpoint any admin session can call directly, so hiding a button
 * only stops shoulder-surfing. The PIN check has to live HERE, on the server,
 * inside that endpoint — a dialog that validates in the browser and then calls
 * the API is bypassed by anyone who opens devtools.
 *
 * The PIN is stored as a bcrypt hash and never leaves the server, not even to
 * the admin who set it. Losing it means setting a new one, which is the correct
 * trade for a credential.
 */

/** bcrypt hash of the current PIN. Absent row ⇒ still on the default. */
export const PIN_HASH_KEY = "admin.impersonationPinHash";
/** Failed-attempt counter + lockout expiry, as JSON. */
export const PIN_LOCK_KEY = "admin.impersonationPinLock";

/** The PIN in force until an admin sets their own. */
export const DEFAULT_PIN = "000000";

export const PIN_LENGTH = 6;
/** Wrong tries before the door closes. */
export const MAX_ATTEMPTS = 5;
/** How long it stays closed. */
export const LOCKOUT_MS = 15 * 60 * 1000;

/** Six digits. Enforced on the way IN so a 1-digit PIN can never be stored. */
export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/**
 * "a•••@example.com" — enough for the admin to recognise which inbox to open,
 * not enough for a hijacked session to read the address out of the response.
 */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "•••";
  const head = local.slice(0, 1) || "•";
  return `${head}${"•".repeat(Math.max(3, local.length - 1))}@${domain}`;
}

async function storedHash(): Promise<string | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: PIN_HASH_KEY } });
  return row?.value ?? null;
}

/**
 * Is `pin` the current one?
 *
 * With no hash stored the platform is still on the default, so that is what a
 * submission is compared against. Deliberately NOT "no hash ⇒ allow anything".
 */
export async function verifyPin(pin: string): Promise<boolean> {
  const hash = await storedHash();
  if (!hash) return pin === DEFAULT_PIN;
  return bcrypt.compare(pin, hash);
}

/** True while the PIN is still 000000 — surfaced so the UI can nag. */
export async function isDefaultPin(): Promise<boolean> {
  return verifyPin(DEFAULT_PIN);
}

export async function setPin(pin: string): Promise<void> {
  const value = await bcrypt.hash(pin, 10);
  await prisma.platformSetting.upsert({
    where: { key: PIN_HASH_KEY },
    update: { value, isSecret: true },
    create: { key: PIN_HASH_KEY, value, isSecret: true },
  });
  // A fresh PIN starts with a clean slate; otherwise failures accumulated
  // against the OLD one could lock the admin out of the new one.
  await clearFailures();
}

interface LockState {
  fails: number;
  /** Epoch ms the lockout expires; 0 when not locked. */
  until: number;
}

/**
 * Attempt state lives in the DATABASE, not in memory.
 *
 * A six-digit PIN is a million combinations — trivially scriptable without a
 * limit — so the limit has to be one an attacker can't shrug off. In-memory
 * counters (like the IP rate limiter in middleware/rateLimit.ts) reset on every
 * deploy and restart, and are per-process; this is the platform's credential,
 * so it is counted once, centrally, and survives both.
 *
 * Counted per PLATFORM rather than per IP for the same reason: rotating IPs must
 * not hand out fresh budgets of guesses.
 */
async function readLock(): Promise<LockState> {
  const row = await prisma.platformSetting.findUnique({ where: { key: PIN_LOCK_KEY } });
  if (!row) return { fails: 0, until: 0 };
  try {
    const parsed = JSON.parse(row.value) as Partial<LockState>;
    return { fails: Number(parsed.fails) || 0, until: Number(parsed.until) || 0 };
  } catch {
    // Corrupt row ⇒ treat as clean rather than locking the admin out forever.
    return { fails: 0, until: 0 };
  }
}

async function writeLock(state: LockState): Promise<void> {
  const value = JSON.stringify(state);
  await prisma.platformSetting.upsert({
    where: { key: PIN_LOCK_KEY },
    update: { value, isSecret: false },
    create: { key: PIN_LOCK_KEY, value, isSecret: false },
  });
}

/** Milliseconds still to wait, or 0 when not locked. */
export async function lockedForMs(): Promise<number> {
  const { until } = await readLock();
  return Math.max(0, until - Date.now());
}

/** Record a wrong PIN. Returns how long the door is now shut for (0 = still open). */
export async function registerFailure(): Promise<number> {
  const state = await readLock();
  const fails = state.fails + 1;
  if (fails >= MAX_ATTEMPTS) {
    const until = Date.now() + LOCKOUT_MS;
    // Counter resets WITH the lockout, so serving the sentence buys a fresh
    // five — rather than one attempt per 15 minutes forever after.
    await writeLock({ fails: 0, until });
    return LOCKOUT_MS;
  }
  await writeLock({ fails, until: 0 });
  return 0;
}

export async function clearFailures(): Promise<void> {
  await writeLock({ fails: 0, until: 0 });
}

/** Attempts left before a lockout — for the "2 tries remaining" message. */
export async function attemptsRemaining(): Promise<number> {
  const { fails } = await readLock();
  return Math.max(0, MAX_ATTEMPTS - fails);
}
