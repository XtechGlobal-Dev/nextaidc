// Platform-wide per-call ceiling. The entitlement budget is per billing cycle, so one caller could
// drain a month of minutes in a sitting. Admin-owned abuse control (customers can't see or raise it); enforced by Vapi's maxDurationSeconds so it can't be bypassed client-side.
import { prisma } from "../prisma.js";

const ENABLED_KEY = "call.maxDuration.enabled";
const SECONDS_KEY = "call.maxDuration.seconds";

/** Five minutes. Chosen by the platform owner as the starting point; the whole
 *  purpose of this module is that it is tunable without a deploy. */
export const DEFAULT_MAX_CALL_SECONDS = 300;

/** Bounds: below cuts ordinary conversations, above stops preventing abuse; also keeps inside Vapi's accepted range. */
export const MIN_MAX_CALL_SECONDS = 60;
export const MAX_MAX_CALL_SECONDS = 3600;

/** Lead time before the ceiling to start closing. Must stay well under MIN_MAX_CALL_SECONDS or a short ceiling warns before the call begins. */
export const WRAP_UP_LEAD_SECONDS = 30;

export interface CallDurationCap {
  enabled: boolean;
  seconds: number;
}

/** The configured ceiling. Absent rows = default, OFF — deploying the feature must never silently start cutting live calls. */
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

/** Applies the ceiling to an entitlement cap (null = unlimited). Only ever LOWERS it; an unlimited plan becomes the ceiling, since that's exactly who a minute-burner targets. */
export function applyCallDurationCap(
  entitlementSeconds: number | null,
  cap: CallDurationCap,
): number | null {
  if (!cap.enabled) return entitlementSeconds;
  if (entitlementSeconds == null) return cap.seconds;
  return Math.min(entitlementSeconds, cap.seconds);
}
