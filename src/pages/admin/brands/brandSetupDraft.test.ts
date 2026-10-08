import { describe, expect, it } from "vitest";
import type { SubscriptionPlan } from "@/lib/api";
import { ALL_MODULES_ON, planBlockedBy, plansOnSale } from "./brandSetupDraft";

const plan = (id: string, addons: Partial<SubscriptionPlan> = {}) =>
  ({
    id,
    callTransferEnabled: false,
    customCrmEnabled: false,
    smsToCallerEnabled: false,
    whatsappEnabled: false,
    ...addons,
  }) as SubscriptionPlan;

const starter = plan("starter");
const pro = plan("pro", { callTransferEnabled: true, whatsappEnabled: true });
const plans = [starter, pro];

describe("planBlockedBy", () => {
  it("names the switched-off modules a plan includes an add-on for", () => {
    expect(planBlockedBy(pro, { ...ALL_MODULES_ON, whatsapp: false })).toEqual(["whatsapp"]);
    expect(planBlockedBy(starter, { ...ALL_MODULES_ON, whatsapp: false })).toEqual([]);
  });

  it("never blocks on booking — plans carry no booking add-on", () => {
    expect(planBlockedBy(pro, { ...ALL_MODULES_ON, booking: false })).toEqual([]);
  });
});

describe("plansOnSale", () => {
  it("keeps an empty pick as 'every plan' while every plan fits", () => {
    expect(plansOnSale([], ALL_MODULES_ON, plans)).toEqual([]);
  });

  it("writes 'every plan' out as the plans that fit once a module rules one out", () => {
    expect(plansOnSale([], { ...ALL_MODULES_ON, transfer: false }, plans)).toEqual(["starter"]);
  });

  it("drops picked plans that no longer fit", () => {
    expect(plansOnSale(["starter", "pro"], { ...ALL_MODULES_ON, whatsapp: false }, plans)).toEqual(["starter"]);
  });
});
