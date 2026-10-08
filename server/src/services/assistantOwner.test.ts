import { describe, it, expect, vi, beforeEach } from "vitest";

// The Vapi webhook asks "whose agent is this assistant?" on every call. With a database per account, a scan of
// all of them would grow with every sign-up — so the answer must come from the call's own hints and Main, and the
// scan is only a last resort.

const h = vi.hoisted(() => ({
  tenants: new Map<string, { conversion: { findFirst: ReturnType<typeof vi.fn> } }>(),
  phoneFindFirst: vi.fn(async (_a: unknown): Promise<{ brandId: string | null } | null> => null),
  allTenants: vi.fn(async () => [...h.tenants].map(([brandId, db]) => ({ brandId, db }))),
  brandIdForOwner: vi.fn(async (_u: string): Promise<string | null> => null),
}));

vi.mock("../prisma.js", () => ({ prisma: { phoneNumber: { findFirst: h.phoneFindFirst } } }));
vi.mock("./tenantDb.js", () => ({
  tenantFor: async (id: string) => {
    const db = h.tenants.get(id);
    if (!db) throw new Error("no such tenant");
    return db;
  },
  allTenants: h.allTenants,
}));
vi.mock("./customerDirectory.js", () => ({ brandIdForOwner: h.brandIdForOwner }));

import { conversionByAssistant, forgetAssistantOwners } from "./assistantOwner.js";

const agent = { id: "c1", userId: "u1", agentConfig: {} };
function tenantWith(assistantId: string | null) {
  return {
    conversion: {
      findFirst: vi.fn(async ({ where }: { where: { vapiAssistantId: string } }) =>
        where.vapiAssistantId === assistantId ? agent : null,
      ),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.phoneFindFirst.mockResolvedValue(null);
  h.brandIdForOwner.mockResolvedValue(null);
  forgetAssistantOwners();
  h.tenants.clear();
  for (let i = 0; i < 50; i++) h.tenants.set(`b${i}`, tenantWith(null));
  h.tenants.set("b_owner", tenantWith("asst_1"));
});

describe("conversionByAssistant", () => {
  it("goes straight to the owner's database from the assistant's owner stamp — no scan", async () => {
    h.brandIdForOwner.mockResolvedValue("b_owner");
    const out = await conversionByAssistant("asst_1", { ownerUserId: "u1" });
    expect(out?.brandId).toBe("b_owner");
    expect(h.allTenants).not.toHaveBeenCalled();
  });

  it("finds it from the call's number in Main's inventory", async () => {
    h.phoneFindFirst.mockResolvedValue({ brandId: "b_owner" });
    const out = await conversionByAssistant("asst_1", { phoneNumber: "+61400000000" });
    expect(out?.brandId).toBe("b_owner");
    expect(h.phoneFindFirst.mock.calls[0][0]).toEqual({
      where: { OR: [{ number: "+61400000000" }, { assistantId: "asst_1" }] },
      select: { brandId: true },
    });
    expect(h.allTenants).not.toHaveBeenCalled();
  });

  it("remembers the answer, so the second webhook of the same call costs one indexed read", async () => {
    h.brandIdForOwner.mockResolvedValue("b_owner");
    await conversionByAssistant("asst_1", { ownerUserId: "u1" });
    vi.clearAllMocks();
    const again = await conversionByAssistant("asst_1");
    expect(again?.brandId).toBe("b_owner");
    expect(h.brandIdForOwner).not.toHaveBeenCalled();
    expect(h.phoneFindFirst).not.toHaveBeenCalled();
  });

  it("never trusts a remembered answer blind — a moved assistant is looked up again", async () => {
    h.brandIdForOwner.mockResolvedValue("b_owner");
    await conversionByAssistant("asst_1", { ownerUserId: "u1" });
    h.tenants.set("b_owner", tenantWith(null));
    h.tenants.set("b7", tenantWith("asst_1"));
    const out = await conversionByAssistant("asst_1");
    expect(out?.brandId).toBe("b7");
  });

  it("only scans when nothing on the call points anywhere", async () => {
    const out = await conversionByAssistant("asst_1");
    expect(out?.brandId).toBe("b_owner");
    expect(h.allTenants).toHaveBeenCalledTimes(1);
  });

  it("returns null for an assistant nobody has", async () => {
    expect(await conversionByAssistant("asst_unknown")).toBeNull();
  });
});
