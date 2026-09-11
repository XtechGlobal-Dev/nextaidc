import { describe, it, expect } from "vitest";
import {
  buildFallbackTranscriber,
  buildTranscriberFallbackPlan,
  isKnownTranscriber,
  transcriberOptionsSnapshot,
  type TranscriberFallbackSetting,
} from "./transcribers.js";

const off: TranscriberFallbackSetting = { autoFallback: false, provider: "", model: "" };

describe("buildFallbackTranscriber — language capability", () => {
  it("builds a Google fallback that carries the tier's language value", () => {
    expect(buildFallbackTranscriber("google", "gemini-2.5-flash", "en")).toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
      language: "English",
    });
    expect(buildFallbackTranscriber("google", "gemini-2.5-flash", "wide")).toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
      language: "Multilingual",
    });
  });

  it("omits the model for a provider that takes none (AssemblyAI)", () => {
    expect(buildFallbackTranscriber("assembly-ai", "", "multi")).toEqual({
      provider: "assembly-ai",
      language: "multi",
    });
  });

  it("skips a provider that can't hear the tier (Deepgram on 'wide')", () => {
    expect(buildFallbackTranscriber("deepgram", "nova-3", "wide")).toBeNull();
    // OpenAI is English-only in our catalogue → no multi/wide.
    expect(buildFallbackTranscriber("openai", "gpt-4o-transcribe", "multi")).toBeNull();
  });

  it("Soniox uses `languages: []` (auto-detect) for multi/wide, `en` for English", () => {
    expect(buildFallbackTranscriber("soniox", "stt-rt-v5", "en")).toEqual({
      provider: "soniox",
      model: "stt-rt-v5",
      language: "en",
    });
    expect(buildFallbackTranscriber("soniox", "stt-rt-v5", "wide")).toEqual({
      provider: "soniox",
      model: "stt-rt-v5",
      languages: [],
    });
  });

  it("defaults the model when the provider needs one but none is given", () => {
    expect(buildFallbackTranscriber("deepgram", "", "en")).toEqual({
      provider: "deepgram",
      model: "nova-3",
      language: "en",
    });
  });
});

describe("buildTranscriberFallbackPlan", () => {
  it("no setting → no plan", () => {
    expect(buildTranscriberFallbackPlan(off, "en")).toBeNull();
  });

  it("manual preferred fallback is included when capable", () => {
    const plan = buildTranscriberFallbackPlan({ autoFallback: false, provider: "google", model: "gemini-2.5-flash" }, "en");
    expect(plan).toEqual({ transcribers: [{ provider: "google", model: "gemini-2.5-flash", language: "English" }] });
  });

  it("skips a manual fallback that can't hear the tier (Deepgram on 'wide')", () => {
    const plan = buildTranscriberFallbackPlan({ autoFallback: false, provider: "deepgram", model: "nova-3" }, "wide");
    expect(plan).toBeNull();
  });

  it("never uses the primary provider as its own fallback", () => {
    // On 'en'/'multi' the primary is Deepgram — a Deepgram manual pick is dropped.
    const plan = buildTranscriberFallbackPlan({ autoFallback: false, provider: "deepgram", model: "nova-3" }, "en");
    expect(plan).toBeNull();
  });

  it("auto fallback appends one capable backup after the manual one", () => {
    const plan = buildTranscriberFallbackPlan({ autoFallback: true, provider: "google", model: "gemini-2.5-flash" }, "en");
    expect(plan!.transcribers[0]).toMatchObject({ provider: "google" });
    // The auto pick is a different, capable provider (not primary 'deepgram', not the manual 'google').
    expect(plan!.transcribers.length).toBe(2);
    const autoProviders = plan!.transcribers.slice(1).map((t) => t.provider);
    expect(autoProviders).not.toContain("deepgram");
    expect(autoProviders).not.toContain("google");
  });

  it("auto fallback alone picks a capable non-primary backup", () => {
    const plan = buildTranscriberFallbackPlan({ autoFallback: true, provider: "", model: "" }, "en");
    expect(plan!.transcribers.length).toBe(1);
    expect(plan!.transcribers[0].provider).not.toBe("deepgram"); // primary on 'en'
  });

  it("'wide' tier auto fallback picks Soniox (wide-capable, not the Google primary)", () => {
    // Google is the 'wide' primary; Soniox also covers 'wide', so it's the backup.
    const plan = buildTranscriberFallbackPlan({ autoFallback: true, provider: "", model: "" }, "wide");
    expect(plan!.transcribers).toEqual([{ provider: "soniox", model: "stt-rt-v5", languages: [] }]);
  });
});

describe("options snapshot + validation", () => {
  it("snapshot lists providers with tiers", () => {
    const snap = transcriberOptionsSnapshot();
    const google = snap.find((o) => o.provider === "google")!;
    expect(google.tiers).toContain("wide");
    const deepgram = snap.find((o) => o.provider === "deepgram")!;
    expect(deepgram.tiers).not.toContain("wide");
    const soniox = snap.find((o) => o.provider === "soniox")!;
    expect(soniox.tiers).toEqual(expect.arrayContaining(["en", "multi", "wide"]));
    expect(soniox.models).toContain("stt-rt-v5");
  });

  it("isKnownTranscriber validates provider + model", () => {
    const snap = transcriberOptionsSnapshot();
    expect(isKnownTranscriber(snap, "google", "gemini-2.5-flash")).toBe(true);
    expect(isKnownTranscriber(snap, "google", "not-a-model")).toBe(false);
    expect(isKnownTranscriber(snap, "assembly-ai", "")).toBe(true); // no model needed
    expect(isKnownTranscriber(snap, "nope", "x")).toBe(false);
  });
});
