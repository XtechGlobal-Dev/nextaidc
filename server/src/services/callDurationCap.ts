/* ------------------------------------------------------------------ *
 *  Global per-call duration ceiling.
 *
 *  A customer's own entitlement already caps how long a call may run (see
 *  remainingCallSeconds in trial.ts) — but that budget is per BILLING CYCLE, not
 *  per call, so one caller who stays on the line deliberately can drain a whole
 *  month of a customer's minutes in a single sitting. This adds a second,
 *  platform-wide ceiling that no single call may exceed, whatever the customer's
 *  plan says.
 *
 *  It is deliberately global and admin-owned: it is an abuse control, not a plan
 *  feature, so a customer can neither see nor raise it.
 *
 *  Enforcement is Vapi's, via the assistant's `maxDurationSeconds` — the same
 *  field the entitlement cap already uses. That means it holds for real inbound
 *  calls and browser test calls alike, and cannot be bypassed from the client.
 * ------------------------------------------------------------------------- */
import { prisma } from "../prisma.js";

const ENABLED_KEY = "call.maxDuration.enabled";
const SECONDS_KEY = "call.maxDuration.seconds";

/** Five minutes. Chosen by the platform owner as the starting point; the whole
 *  purpose of this module is that it is tunable without a deploy. */
export const DEFAULT_MAX_CALL_SECONDS = 300;

/** Below this the ceiling stops being an abuse control and starts cutting
 *  ordinary conversations; above it the call costs more than the abuse it
 *  prevents. Also keeps the value inside Vapi's own accepted range. */
export const MIN_MAX_CALL_SECONDS = 60;
export const MAX_MAX_CALL_SECONDS = 3600;

/** How long before the ceiling the assistant is told to start closing, so the
 *  caller gets a sentence rather than a dead line. Must stay comfortably under
 *  MIN_MAX_CALL_SECONDS or a short ceiling would warn before the call began. */
export const WRAP_UP_LEAD_SECONDS = 30;

export interface CallDurationCap {
  enabled: boolean;
  seconds: number;
}

/** The configured ceiling. Absent rows → the default, switched OFF: turning this
 *  on is an explicit act, so deploying the feature never silently starts cutting
 *  live calls on existing accounts. */
export async function getCallDurationCapSetting(): Promise<CallDurationCap> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: [ENABLED_KEY, SECONDS_KEY] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const rawSeconds = Number(byKey.get(SECONDS_KEY));
  return {
    enabled: byKey.get(ENABLED_KEY) === "true",
    seconds: Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : DEFAULT_MAX_CALL_SECONDS,
  };
}

export async function setCallDurationCapSetting(input: CallDurationCap): Promise<CallDurationCap> {
  const seconds = Math.min(MAX_MAX_CALL_SECONDS, Math.max(MIN_MAX_CALL_SECONDS, Math.floor(input.seconds)));
  for (const [key, value] of [
    [ENABLED_KEY, String(input.enabled)],
    [SECONDS_KEY, String(seconds)],
  ] as const) {
    await prisma.platformSetting.upsert({
      where: { key },
      update: { value, isSecret: false },
      create: { key, value, isSecret: false },
    });
  }
  return { enabled: input.enabled, seconds };
}

/** Apply the ceiling to a per-user entitlement cap.
 *
 *  `entitlementSeconds` is what the customer's plan allows (null = unlimited).
 *  The ceiling only ever LOWERS that: a customer with three minutes left still
 *  gets three minutes, not five. An unlimited plan becomes the ceiling, which is
 *  the point — an unlimited customer is exactly who a minute-burner would target
 *  if the ceiling let them through. */
export function applyCallDurationCap(
  entitlementSeconds: number | null,
  cap: CallDurationCap,
): number | null {
  if (!cap.enabled) return entitlementSeconds;
  if (entitlementSeconds == null) return cap.seconds;
  return Math.min(entitlementSeconds, cap.seconds);
}
