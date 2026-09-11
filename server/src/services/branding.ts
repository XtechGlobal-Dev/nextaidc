import { prisma } from "../prisma.js";
import { uploadObject, deleteObject, type UploadResult } from "./storage.js";

/* ------------------------------------------------------------------ *
 *  Platform branding — admin-uploaded logos + favicon stored in S3.
 *  Each slot keeps its public URL (shown to all clients) plus the S3
 *  object key (so a replaced asset can be deleted). Persisted as plain,
 *  non-secret rows in platform_settings.
 * ------------------------------------------------------------------ */

export type BrandingSlot =
  | "logoLight"
  | "logoDark"
  | "favicon"
  | "avatarFemale"
  | "avatarMale";

export const BRANDING_SLOTS: { slot: BrandingSlot; label: string; prefix: string }[] = [
  { slot: "logoLight", label: "Light-mode logo", prefix: "branding/logo-light" },
  { slot: "logoDark", label: "Dark-mode logo", prefix: "branding/logo-dark" },
  { slot: "favicon", label: "Favicon", prefix: "branding/favicon" },
  // Onboarding AI-receptionist persona photos, picked by the selected voice's
  // gender (see the frontend's avatarForVoice). Blank → built-in stock headshot.
  { slot: "avatarFemale", label: "Onboarding avatar (female voice)", prefix: "branding/avatar-female" },
  { slot: "avatarMale", label: "Onboarding avatar (male voice)", prefix: "branding/avatar-male" },
];

const SLOT_SET = new Set<BrandingSlot>(BRANDING_SLOTS.map((s) => s.slot));
export function isBrandingSlot(v: string): v is BrandingSlot {
  return SLOT_SET.has(v as BrandingSlot);
}

const urlKey = (slot: BrandingSlot) => `branding.${slot}.url`;
const objKey = (slot: BrandingSlot) => `branding.${slot}.key`;

export type Branding = Record<BrandingSlot, string>;

export async function getBranding(): Promise<Branding> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: BRANDING_SLOTS.map((s) => urlKey(s.slot)) } },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Branding;
  for (const { slot } of BRANDING_SLOTS) out[slot] = byKey.get(urlKey(slot)) ?? "";
  return out;
}

async function storedObjectKey(slot: BrandingSlot): Promise<string> {
  const row = await prisma.platformSetting.findUnique({ where: { key: objKey(slot) } });
  return row?.value ?? "";
}

async function setSetting(key: string, value: string) {
  await prisma.platformSetting.upsert({
    where: { key },
    update: { value, isSecret: false },
    create: { key, value, isSecret: false },
  });
}

/** Upload a new asset for a slot to S3, replacing (and cleaning up) any prior one. */
export async function setBrandingAsset(
  slot: BrandingSlot,
  body: Buffer,
  mime: string,
  originalName: string,
): Promise<Branding> {
  const def = BRANDING_SLOTS.find((s) => s.slot === slot)!;
  const previousKey = await storedObjectKey(slot);
  const result: UploadResult = await uploadObject(def.prefix, body, mime, originalName);
  await setSetting(urlKey(slot), result.url);
  await setSetting(objKey(slot), result.key);
  if (previousKey && previousKey !== result.key) await deleteObject(previousKey);
  return getBranding();
}

/** Remove a slot's asset (DB rows + the S3 object). */
export async function clearBrandingAsset(slot: BrandingSlot): Promise<Branding> {
  const previousKey = await storedObjectKey(slot);
  await prisma.platformSetting.deleteMany({ where: { key: { in: [urlKey(slot), objKey(slot)] } } });
  if (previousKey) await deleteObject(previousKey);
  return getBranding();
}
