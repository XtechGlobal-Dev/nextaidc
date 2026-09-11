/**
 * Human Call Transfer — shared constants and validation for the single-number
 * transfer settings. No I/O here.
 */
import { z } from "zod";

/** Default ring time before the AI gives up and speaks the end message. */
export const DEFAULT_RING_TIMEOUT_SEC = 25;
export const MIN_RING_TIMEOUT_SEC = 10;
export const MAX_RING_TIMEOUT_SEC = 120;

/** The line the AI speaks when the transfer can't connect. */
export const DEFAULT_FALLBACK_MESSAGE =
  "Our support team isn't available right now. We've recorded your request and will contact you as soon as possible. Thank you for calling.";

const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9\s()-]{6,20}$/, "Enter a valid phone number");

export const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  // Allow clearing the number ("") or setting a valid one.
  transferNumber: z.union([phone, z.literal("")]).optional(),
  ringTimeoutSec: z
    .number()
    .int()
    .min(MIN_RING_TIMEOUT_SEC)
    .max(MAX_RING_TIMEOUT_SEC)
    .optional(),
  fallbackMessage: z.string().trim().max(600).optional(),
});

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/**
 * Hard ceiling on departments for ANY plan, unlimited included — the transfer
 * tool stops being usable for a caller long before this, and it bounds the
 * prompt we hand Vapi. Plan limits are enforced on top of it, never above it.
 */
export const MAX_DEPARTMENTS = 20;

/** The half of a plan that decides transfer access. */
export interface TransferPlanLimits {
  callTransferEnabled: boolean;
  /** 0 = unlimited (see schema.prisma). Meaningless while disabled. */
  callTransferLimit: number;
}

/**
 * How many departments this plan may configure, as one number.
 *
 * The stored pair is deliberately never read raw: `callTransferLimit` is 0 for
 * BOTH "unlimited" and "irrelevant, the feature is off", so reading it alone
 * gets the STARTER case exactly backwards. Everything that needs the allowance
 * goes through here instead.
 *
 * Returns 0 when the plan excludes transfer entirely, otherwise the plan's cap
 * clamped to MAX_DEPARTMENTS.
 */
export function transferDepartmentAllowance(plan: TransferPlanLimits | null | undefined): number {
  if (!plan?.callTransferEnabled) return 0;
  const limit = plan.callTransferLimit;
  return limit > 0 ? Math.min(limit, MAX_DEPARTMENTS) : MAX_DEPARTMENTS;
}

/** Default per-department ring time before the AI speaks that department's end message. */
export const DEFAULT_DEPARTMENT_RING_TIMEOUT_SEC = 15;

const ringTimeout = z.number().int().min(MIN_RING_TIMEOUT_SEC).max(MAX_RING_TIMEOUT_SEC);

/** Create/replace payload for a single department. */
export const departmentInputSchema = z.object({
  name: z.string().trim().min(1, "Department name is required").max(60),
  number: z.union([phone, z.literal("")]),
  description: z.string().trim().max(200).optional().default(""),
  enabled: z.boolean().optional().default(true),
  ringTimeoutSec: ringTimeout.optional().default(DEFAULT_DEPARTMENT_RING_TIMEOUT_SEC),
  fallbackMessage: z.string().trim().max(600).optional().default(DEFAULT_FALLBACK_MESSAGE),
});

/** Partial update for an existing department. */
export const departmentPatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  number: z.union([phone, z.literal("")]).optional(),
  description: z.string().trim().max(200).optional(),
  enabled: z.boolean().optional(),
  ringTimeoutSec: ringTimeout.optional(),
  fallbackMessage: z.string().trim().max(600).optional(),
  order: z.number().int().min(0).optional(),
});

export type DepartmentInput = z.infer<typeof departmentInputSchema>;
export type DepartmentPatch = z.infer<typeof departmentPatchSchema>;

/** One department in a full "replace all" save (staged in the UI, committed
 *  together with the rest of the transfer settings on Save). */
export const departmentReplaceItemSchema = z.object({
  name: z.string().trim().min(1, "Department name is required").max(60),
  number: z.union([phone, z.literal("")]).default(""),
  description: z.string().trim().max(200).optional().default(""),
  enabled: z.boolean().optional().default(true),
  ringTimeoutSec: ringTimeout.optional().default(DEFAULT_DEPARTMENT_RING_TIMEOUT_SEC),
  fallbackMessage: z.string().trim().max(600).optional().default(DEFAULT_FALLBACK_MESSAGE),
});

/** Replace the owner's entire department list in one atomic save. */
export const departmentsReplaceSchema = z.object({
  departments: z.array(departmentReplaceItemSchema).max(MAX_DEPARTMENTS),
});

export type DepartmentReplaceItem = z.infer<typeof departmentReplaceItemSchema>;
