import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs guard script, no types, imported for its pure half.
import { dangerousOperations, isPartitionChild } from "../../scripts/schemaDrift.mjs";

/* ------------------------------------------------------------------ *
 *  The pre-deploy guard's decision logic.
 *
 *  Two ways to get this wrong, and both end with it being useless:
 *    - miss a destructive plan → the thing it exists to prevent happens;
 *    - flag routine column additions → someone deletes the guard within a
 *      week, and then the thing it exists to prevent happens anyway.
 * ------------------------------------------------------------------ */

describe("catches what would destroy the call history", () => {
  it("flags a plan that drops call_logs", () => {
    const diff = `-- DropTable\nDROP TABLE "call_logs";`;
    expect(dangerousOperations(diff)).toHaveLength(1);
  });

  // The real signature of the failure mode: Prisma cannot see that a
  // partitioned parent exists, so its plan is to create it.
  it("flags a plan that recreates call_logs", () => {
    const diff = `-- CreateTable\nCREATE TABLE "call_logs" (\n    "id" TEXT NOT NULL\n);`;
    const found = dangerousOperations(diff);
    expect(found).toHaveLength(1);
    expect(found[0].table).toBe("call_logs");
  });

  it("protects the tenant detail table too", () => {
    expect(dangerousOperations(`DROP TABLE "call_details";`)).toHaveLength(1);
  });

  it("reports every offending statement, not just the first", () => {
    const diff = `DROP TABLE "call_logs";\nCREATE TABLE "call_details" ("x" TEXT);`;
    expect(dangerousOperations(diff)).toHaveLength(2);
  });
});

describe("stays quiet about routine changes", () => {
  // If adding a column trips the guard, the guard gets deleted.
  it("allows adding a column to call_logs", () => {
    const diff = `-- AlterTable\nALTER TABLE "call_logs" ADD COLUMN "sentiment" TEXT;`;
    expect(dangerousOperations(diff)).toEqual([]);
  });

  it("allows index and constraint churn on call_logs", () => {
    const diff =
      `CREATE INDEX "call_logs_intent_idx" ON "call_logs"("intent");\n` +
      `DROP INDEX "call_logs_publicId_key";\n` +
      `ALTER TABLE "call_logs" DROP CONSTRAINT "call_logs_pkey";`;
    expect(dangerousOperations(diff)).toEqual([]);
  });

  it("ignores other tables entirely — they are Prisma's to manage", () => {
    const diff = `DROP TABLE "users";\nCREATE TABLE "brand_databases" ("brandId" TEXT);`;
    expect(dangerousOperations(diff)).toEqual([]);
  });

  it("ignores commented-out SQL", () => {
    expect(dangerousOperations(`-- DROP TABLE "call_logs";`)).toEqual([]);
  });

  it("passes an empty diff", () => {
    expect(dangerousOperations("")).toEqual([]);
  });
});

describe("isPartitionChild", () => {
  // Dropping a monthly partition is the retention sweep doing its job; it is
  // never something Prisma's diff proposes, and must not read as an alarm.
  it("recognises the monthly children and the catch-all", () => {
    expect(isPartitionChild("call_logs_2026_09")).toBe(true);
    expect(isPartitionChild("call_details_2026_09")).toBe(true);
    expect(isPartitionChild("call_logs_default")).toBe(true);
  });

  it("does not mistake the parent for a child", () => {
    expect(isPartitionChild("call_logs")).toBe(false);
    expect(isPartitionChild("call_details")).toBe(false);
  });
});
