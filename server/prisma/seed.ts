import "dotenv/config";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  TRIAL_DAYS_KEY,
  DEFAULT_TRIAL_DAYS,
  TRIAL_MINUTES_KEY,
  DEFAULT_TRIAL_MINUTES,
} from "../src/services/billing.js";

const prisma = new PrismaClient();

function hpw(p: string) {
  return bcrypt.hash(p, 10);
}

/**
 * Three default subscription tiers — a classic good/better/best ladder. Prices
 * are USD cents. The middle tier is flagged `recommended` so the subscribe page
 * paints a "Popular" badge on it (the anchor that drives most upgrades).
 * `features` are display-only marketing bullets; `smsEnabled` / `whatsappEnabled`
 * are the real entitlement flags the services gate on. `includedMinutes: 0` on a
 * paid plan renders as "Unlimited minutes" on the subscribe page.
 */
const DEFAULT_PLANS = [
  {
    name: "starter",
    displayName: "Starter",
    description: "For solo owners who can't afford to miss a call.",
    priceCents: 4900, // $49/mo
    includedMinutes: 250,
    smsEnabled: false,
    whatsappEnabled: false,
    customCrmEnabled: false,
    multilingualEnabled: false,
    recommended: false,
    sortOrder: 1,
    features: [
      "24/7 AI receptionist — never miss a call",
      "Trained on your business in minutes",
      "Call transcripts & summaries",
      "Automatic lead capture to your CRM",
      "Instant email notifications",
    ],
  },
  {
    name: "professional",
    displayName: "Professional",
    description: "Our most popular plan for growing teams.",
    priceCents: 14900, // $149/mo
    includedMinutes: 1000,
    smsEnabled: true,
    whatsappEnabled: false,
    customCrmEnabled: false,
    multilingualEnabled: false,
    recommended: true,
    sortOrder: 2,
    features: [
      "Everything in Starter",
      "Post-call SMS summaries to your phone",
      "Calendar booking & appointment scheduling",
      "Spam & robocall filtering",
      "After-hours call routing",
      "Priority voice selection",
    ],
  },
  {
    name: "business",
    displayName: "Business",
    description: "Unlimited answering for high-volume businesses.",
    priceCents: 34900, // $349/mo
    includedMinutes: 0, // 0 on a paid plan → shown as "Unlimited minutes"
    smsEnabled: true,
    whatsappEnabled: true,
    customCrmEnabled: true,
    multilingualEnabled: true,
    recommended: false,
    sortOrder: 3,
    features: [
      "Everything in Professional",
      "Unlimited call minutes",
      "WhatsApp summaries + AI auto-reply",
      "Premium voice bank",
      "Multi-location & team support",
      "Dedicated onboarding + priority support",
    ],
  },
] as const;

/** Seed the super admin, trial defaults and plan tiers (idempotent — safe to run repeatedly). */
export async function seed() {
  const superEmail = process.env.SEED_SUPER_ADMIN_EMAIL ?? "superadmin@ai.com";
  const superPassword = process.env.SEED_SUPER_ADMIN_PASSWORD ?? "Super@001";
  const superName = process.env.SEED_SUPER_ADMIN_NAME ?? "Super Admin";

  // The platform owner — the ONE account allowed to have no brand. The
  // SUPER_ADMIN sits above every tenant, which is exactly what makes
  // tenantScope() give them the platform-wide view. No profile/conversion
  // either: they administer the platform, they aren't a customer of it.
  //
  // Nothing else is seeded as a user. Every other account belongs to a brand
  // (the database enforces it — migration 0057; the platform's own support
  // staff are the one other exception), so customers come from a brand's
  // sign-up door, brand admins from the Brands page, and platform staff from
  // the super admin's Staff page.
  //
  // The upsert's `update` re-asserts the role and password on every run, so a
  // re-seed always restores a known-good way in.
  await prisma.user.upsert({
    where: { email: superEmail },
    update: {
      role: "SUPER_ADMIN",
      fullName: superName,
      passwordHash: await hpw(superPassword),
    },
    create: {
      email: superEmail,
      fullName: superName,
      role: "SUPER_ADMIN",
      passwordHash: await hpw(superPassword),
    },
  });

  // Seed the global trial limits if unset. `update: {}` keeps any value the
  // admin later customizes — re-seeding never clobbers it. The app also falls
  // back to these same defaults in code when a row is missing.
  for (const [key, value] of [
    [TRIAL_DAYS_KEY, DEFAULT_TRIAL_DAYS],
    [TRIAL_MINUTES_KEY, DEFAULT_TRIAL_MINUTES],
  ] as const) {
    await prisma.platformSetting.upsert({
      where: { key },
      update: {},
      create: { key, value: String(value), isSecret: false },
    });
  }

  // Seed the default plan tiers if a plan with that key doesn't exist yet.
  // Create-only (like the trial defaults above) so re-seeding never overwrites
  // prices or copy the admin has since customized in the dashboard.
  for (const plan of DEFAULT_PLANS) {
    const existing = await prisma.subscriptionPlan.findFirst({ where: { name: plan.name } });
    if (existing) continue;
    await prisma.subscriptionPlan.create({
      data: {
        name: plan.name,
        displayName: plan.displayName,
        description: plan.description,
        priceCents: plan.priceCents,
        interval: "month",
        includedMinutes: plan.includedMinutes,
        smsEnabled: plan.smsEnabled,
        whatsappEnabled: plan.whatsappEnabled,
        customCrmEnabled: plan.customCrmEnabled,
        multilingualEnabled: plan.multilingualEnabled,
        features: plan.features as unknown as object,
        recommended: plan.recommended,
        sortOrder: plan.sortOrder,
        active: true,
      },
    });
  }

  console.log(`✅ Super admin: ${superEmail}`);
  console.log(`✅ Trial defaults: ${DEFAULT_TRIAL_DAYS} days / ${DEFAULT_TRIAL_MINUTES} min`);
  console.log(`✅ Plans: ${DEFAULT_PLANS.map((p) => p.displayName).join(", ")}`);
  console.log("🌱 Seed complete.");
}

// Run automatically only when executed directly (not when imported).
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  seed()
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
