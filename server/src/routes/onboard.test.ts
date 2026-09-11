import { describe, it, expect } from "vitest";
import { pickServices } from "./onboard.routes.js";

describe("pickServices", () => {
  it("extracts from a dedicated services section, skipping nav + portfolio", () => {
    const html = `
      <header><nav><ul>
        <li>Home</li><li>Who We Are</li><li>Insights</li><li>Contact</li>
      </ul></nav></header>
      <section><h2>Our Services</h2><ul>
        <li>Web Development</li>
        <li>Cloud Engineering</li>
        <li>SEO Marketing</li>
      </ul></section>
      <section><h2>Our Clients</h2><ul>
        <li>Adobe</li><li>ADDA 247</li><li>Gemini Horoscope App</li>
      </ul></section>`;
    expect(pickServices(html, "")).toEqual(["Web Development", "Cloud Engineering", "SEO Marketing"]);
  });

  it("falls back to offerings listed in the meta description", () => {
    const html = `<nav><li>Home</li><li>Who We Are</li><li>Insights</li></nav>`;
    const desc =
      "DigiMantra helps businesses scale with AI-powered digital transformation, software development, cloud engineering, and modern technology solutions.";
    expect(pickServices(html, desc)).toEqual([
      "software development",
      "cloud engineering",
      "modern technology solutions",
    ]);
  });

  it("filters nav/footer/question junk in the general fallback", () => {
    const html = `
      <h2>Who We Are</h2>
      <h3>Insights</h3>
      <li>Privacy Policy</li>
      <li>Plumbing Repair</li>
      <li>Drain Cleaning</li>`;
    const out = pickServices(html, "");
    expect(out).toContain("Plumbing Repair");
    expect(out).toContain("Drain Cleaning");
    expect(out).not.toContain("Who We Are");
    expect(out).not.toContain("Insights");
    expect(out).not.toContain("Privacy Policy");
  });
});
