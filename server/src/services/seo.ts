import { prisma } from "../prisma.js";

/* ------------------------------------------------------------------ *
 *  Admin-managed custom scripts/tags (SEO & tracking) — raw HTML
 *  snippets (Google Analytics, GTM, Meta Pixel, verification metas…)
 *  pasted in Admin → Settings and injected by the frontend into the
 *  chosen slot on every page load: <head>, start of <body>, or the
 *  footer (end of <body>). No code deploy needed to change them.
 * ------------------------------------------------------------------ */

const SCRIPTS_KEY = "seo.scripts";
/** Generous per-slot cap — GTM + a couple of pixels fit well within this. */
const MAX_CODE = 20_000;

export interface SeoScripts {
  /** Injected into <head>. */
  head: string;
  /** Injected at the start of <body>. */
  body: string;
  /** Injected at the end of <body> (footer). */
  footer: string;
}

const clean = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, MAX_CODE) : "");

export async function getSeoScripts(): Promise<SeoScripts> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: SCRIPTS_KEY } });
    const o = row?.value ? (JSON.parse(row.value) as Record<string, unknown>) : {};
    return { head: clean(o.head), body: clean(o.body), footer: clean(o.footer) };
  } catch {
    return { head: "", body: "", footer: "" };
  }
}

export async function setSeoScripts(raw: unknown): Promise<SeoScripts> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const scripts: SeoScripts = { head: clean(o.head), body: clean(o.body), footer: clean(o.footer) };
  await prisma.platformSetting.upsert({
    where: { key: SCRIPTS_KEY },
    update: { value: JSON.stringify(scripts), isSecret: false },
    create: { key: SCRIPTS_KEY, value: JSON.stringify(scripts), isSecret: false },
  });
  return scripts;
}
