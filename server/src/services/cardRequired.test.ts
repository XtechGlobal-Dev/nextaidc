import { describe, it, expect, vi, beforeEach } from "vitest";

/* The `onboarding.cardRequired` platform setting — the admin toggle that decides
 * whether a NEW signup must put a card on file before the dashboard opens.
 *
 * The value is deliberately read straight off the row rather than through the
 * in-memory settings cache: that cache only refreshes at boot and after a local
 * save, so on a multi-instance deploy a flip on one instance would keep stamping
 * the stale policy on new signups elsewhere until a restart. */

vi.mock("../prisma.js", () => ({
  prisma: {
    platformSetting: {
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({})),
    },
  },
}));

import { prisma } from "../prisma.js";
import {
  getOnboardingCardRequired,
  setOnboardingCardRequired,
  ONBOARDING_CARD_REQUIRED_KEY,
} from "./settings.js";

const findUnique = prisma.platformSetting.findUnique as unknown as ReturnType<typeof vi.fn>;
const upsert = prisma.platformSetting.upsert as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("getOnboardingCardRequired", () => {
  it("defaults to OFF when no admin has ever saved it", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getOnboardingCardRequired()).toBe(false);
  });

  it("reads a saved 'true' as ON", async () => {
    findUnique.mockResolvedValue({ key: ONBOARDING_CARD_REQUIRED_KEY, value: "true" });
    expect(await getOnboardingCardRequired()).toBe(true);
  });

  it("tolerates surrounding whitespace", async () => {
    findUnique.mockResolvedValue({ value: " true " });
    expect(await getOnboardingCardRequired()).toBe(true);
  });

  // Boolean(getEffective(key)) would read the STRING "false" as true and turn the
  // wall on for everyone — the setting is stored as text, so the literal matters.
  it.each(["false", "1", "yes", "TRUE", "", "0"])(
    "treats %o as OFF — only the literal 'true' enables the wall",
    async (value) => {
      findUnique.mockResolvedValue({ value });
      expect(await getOnboardingCardRequired()).toBe(false);
    },
  );

  it("reads the row directly, not the in-memory settings cache", async () => {
    findUnique.mockResolvedValue(null);
    await getOnboardingCardRequired();
    expect(findUnique).toHaveBeenCalledWith({ where: { key: ONBOARDING_CARD_REQUIRED_KEY } });
  });
});

describe("setOnboardingCardRequired", () => {
  it("stores the boolean as a non-secret string row", async () => {
    await setOnboardingCardRequired(true);
    expect(upsert).toHaveBeenCalledWith({
      where: { key: ONBOARDING_CARD_REQUIRED_KEY },
      update: { value: "true", isSecret: false },
      create: { key: ONBOARDING_CARD_REQUIRED_KEY, value: "true", isSecret: false },
    });
  });

  it("writes an explicit 'false' rather than deleting the row", async () => {
    await setOnboardingCardRequired(false);
    expect(upsert.mock.calls[0][0].update.value).toBe("false");
  });
});
