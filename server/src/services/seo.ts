import { prisma } from "../prisma.js";

// Admin-pasted raw HTML snippets (GA, GTM, pixels) the frontend injects into
// <head>, body start, or footer — changeable without a deploy.

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
