import express from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { assertPublicHttpUrl, isPublicHttpUrl } from "../lib/ssrfGuard.js";
import { getEffective, integrationsStatus } from "../services/settings.js";
import { buildChatBody, openAiTokenUnits } from "../lib/openai.js";
import { traceFetch } from "../services/apiTrace.js";
import { decodeHtml } from "../lib/escapeHtml.js";

const router = express.Router();

const NAV_JUNK = new Set([
  "home", "about", "about us", "contact", "contact us", "login", "log in", "sign in", "sign up",
  "get started", "menu", "blog", "faq", "faqs", "pricing", "services", "products", "careers",
  "privacy", "terms", "book a demo", "search", "next", "previous", "read more", "learn more",
  // section / nav / footer labels that are not actual services
  "who we are", "what we do", "our work", "work", "our team", "team", "our story", "story",
  "our mission", "mission", "our values", "values", "portfolio", "clients", "our clients",
  "case studies", "case study", "testimonials", "insights", "news", "resources", "company",
  "overview", "features", "integrations", "use cases", "partners", "press", "media", "events",
  "gallery", "apps", "documentation", "docs", "community", "process", "our process",
  "how it works", "why us", "why choose us", "newsletter", "subscribe", "follow us",
  "get in touch", "request a quote", "free trial", "demo", "support", "help",
  // e-commerce / SPA nav, account & call-to-action labels (not real services)
  "choose your option", "select an option", "select option", "call us", "get help",
  "shop", "shop now", "buy now", "add to cart", "my account", "account", "wishlist",
  "cart", "collection", "collections", "category", "categories", "view all", "see all",
  "explore", "view more", "show more", "all categories", "track", "offers", "deals",
]);

/** Patterns that mark a heading/list item as nav/footer chrome, not a service. */
const JUNK_PATTERNS: RegExp[] = [
  /^(who|what|why|how|where|when)\b/i, // "Who We Are", "What We Do", "Why Choose Us"
  /\b(policy|policies|terms|cookies?|copyright|rights reserved|sitemap|unsubscribe|sign\s?up|log\s?in|get started|read more|learn more|view all|see all)\b/i,
  /©|™|®/,
];

/** True when a scraped heading/list item plausibly names a real service. */
function isLikelyService(raw: string): boolean {
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.length < 3 || s.length > 48) return false;
  if (!/[a-z]/i.test(s)) return false; // needs letters (drops "247", symbols)
  if (/^\W*\d/.test(s)) return false; // starts with a number ("24/7 support", years)
  if (NAV_JUNK.has(s.toLowerCase())) return false;
  if (JUNK_PATTERNS.some((re) => re.test(s))) return false;
  return true;
}

/** Filter + dedupe (case-insensitive) a list of candidate service names. Deliberately
 *  uncapped — the LLM's relevance rules decide what belongs, not an arbitrary count. */
function cleanServices(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const t = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!isLikelyService(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

const SERVICE_SECTION = /services|what we (do|offer)|our (services|solutions|offerings|expertise)|expertise|capabilities|offerings/i;

/**
 * Best source: a dedicated "Our Services / What We Do" section. Find such a
 * heading and pull the card titles / list items that immediately follow it —
 * this skips nav menus and portfolio/client logos elsewhere on the page.
 */
function servicesFromSection(html: string): string[] {
  const headingRe = /<h[1-4][^>]*>([\s\S]{2,60}?)<\/h[1-4]>/gi;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html))) {
    const label = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!SERVICE_SECTION.test(label) || NAV_JUNK.has(label.toLowerCase())) continue;
    const start = m.index + m[0].length;
    // Only scan up to the next section boundary so we don't bleed into a
    // following "Our Clients" / "Portfolio" block (brand names, not services).
    const rest = html.slice(start, start + 4000);
    const boundary = rest.search(/<h[12][\s>]|<\/section|<footer/i);
    const slice = boundary > 0 ? rest.slice(0, boundary) : rest;
    const items = Array.from(
      slice.matchAll(/<(?:h3|h4|li|strong|b)[^>]*>([\s\S]{3,48}?)<\/(?:h3|h4|li|strong|b)>/gi),
    ).map((x) => x[1]);
    const cleaned = cleanServices(items);
    if (cleaned.length >= 2) return cleaned;
  }
  return [];
}

/**
 * Fallback: many sites summarise their offerings in the meta description, e.g.
 * "…digital transformation, software development, cloud engineering…". Split it
 * into short, service-like noun phrases.
 */
function servicesFromDescription(description: string): string[] {
  if (!description) return [];
  const SERVICEY =
    /develop|design|market|consult|solution|engineer|manage|support|strateg|transform|integrat|migrat|automat|optimi|secur|clean|repair|install|maintenance|plumb|electric|paint|landscap|account|legal|seo|advertis|brand|content|coach|build|train|host|deliver/i;
  const parts = description
    .split(/[.;:]/)
    .flatMap((chunk) => chunk.split(/,| and | & /i))
    .map((p) =>
      p
        .replace(/^(we|our|offering|including|such as|like|providing|speciali[sz]ing in|services?:?)\s+/i, "")
        .replace(/^(a|an|the)\s+/i, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((p) => {
      const words = p.split(/\s+/).length;
      return words >= 1 && words <= 5 && SERVICEY.test(p);
    });
  return cleanServices(parts);
}

/**
 * Pick a business's services, best source first:
 *  1. a dedicated "Our Services / What We Do" section,
 *  2. the offerings listed in the meta description,
 *  3. a junk-filtered scan of all headings/list items.
 * Exported for unit testing.
 */
export function pickServices(html: string, description: string): string[] {
  const section = servicesFromSection(html);
  if (section.length >= 2) return section;
  const desc = servicesFromDescription(description);
  if (desc.length >= 2) return desc;
  const general = Array.from(
    html.matchAll(/<(?:h2|h3|li)[^>]*>([^<]{3,48})<\/(?:h2|h3|li)>/gi),
  ).map((m) => m[1]);
  return cleanServices(general);
}

function firstMatch(html: string, re: RegExp): string {
  const m = html.match(re);
  // Scraped snippets come straight from markup, so decode HTML entities
  // (e.g. "&amp;" → "&") before they become plain-text business copy.
  return m ? decodeHtml(m[1].replace(/\s+/g, " ").trim()) : "";
}

function siteHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
}

function businessNameFromUrl(url: string): string {
  const label = siteHost(url).split(".")[0] || "Your Business";
  return capFirst(label);
}

function capFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

const IMG_EXT = /\.(png|jpe?g|gif|svg|webp)$/;

/**
 * Pick the business email. Only trusts reliable signals — schema.org, `mailto:`
 * links, and addresses on the site's own domain — so a stray third-party email
 * scraped from page copy (a testimonial, embed, screenshot alt-text) is ignored.
 * Returns "" rather than guessing wrong.
 */
function pickEmail(html: string, host: string, ldEmail: string): string {
  if (ldEmail) return ldEmail;
  const clean = (e: string) =>
    !IMG_EXT.test(e) && !e.includes("sentry") && !e.includes("example.") && !e.endsWith("@");
  const mailto = Array.from(html.matchAll(/href=["']mailto:([^"'?>\s]+)/gi))
    .map((m) => decodeURIComponent(m[1]).toLowerCase().trim())
    .filter(clean);
  const text = (html.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])
    .map((e) => e.toLowerCase())
    .filter(clean);
  const onDomain = (e: string) => Boolean(e.split("@")[1]?.endsWith(host));
  // Same-domain address (most trustworthy) → any explicit mailto link → blank.
  return [...mailto, ...text].find(onDomain) || mailto[0] || "";
}

/**
 * Pick the business phone. Only trusts schema.org `telephone` and `tel:` links —
 * never a raw run of digits scraped from the page (prices, stats, etc.), which
 * produced bogus "phone numbers". Returns "" rather than guessing wrong.
 */
function pickPhone(html: string, ldPhone: string): string {
  if (ldPhone) return ldPhone;
  const tel = Array.from(html.matchAll(/href=["']tel:([^"'>\s]+)/gi))
    .map((m) => decodeURIComponent(m[1]).replace(/[^\d+]/g, ""))
    .filter((p) => {
      const digits = p.replace(/\D/g, "");
      return digits.length >= 8 && digits.length <= 15;
    });
  return tel[0] || "";
}

/** Pull phone / email / address out of schema.org JSON-LD — the most reliable source when present. */
function extractJsonLd(html: string): { phone: string; email: string; address: string } {
  const out = { phone: "", email: "", address: "" };
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    const nodes = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>)["@graph"])
        ? ((data as Record<string, unknown>)["@graph"] as unknown[])
        : [data];

    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const n = node as Record<string, unknown>;
      if (!out.phone && typeof n.telephone === "string") out.phone = n.telephone.trim();
      if (!out.email && typeof n.email === "string") out.email = n.email.replace(/^mailto:/i, "").trim();
      if (!out.address) {
        const addr = n.address;
        if (typeof addr === "string") {
          out.address = addr.replace(/\s+/g, " ").trim();
        } else if (addr && typeof addr === "object") {
          const a = addr as Record<string, unknown>;
          out.address = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
            .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
            .map((p) => p.trim())
            .join(", ");
        }
      }
    }
  }
  return out;
}

interface FaqPair {
  question: string;
  answer: string;
}

/** Collapse an HTML/encoded snippet to plain readable text. */
function htmlToPlain(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull FAQs out of schema.org JSON-LD (`FAQPage` → `mainEntity` → `Question` /
 * `acceptedAnswer`). The most reliable source when present — walks the whole
 * tree (incl. `@graph`) so nested FAQ blocks are found. Capped at 8 pairs.
 */
function extractFaqJsonLd(html: string): FaqPair[] {
  const out: FaqPair[] = [];
  const seen = new Set<string>();
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    const stack: unknown[] = [data];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      if (!node || typeof node !== "object") continue;
      const n = node as Record<string, unknown>;
      if (Array.isArray(n["@graph"])) stack.push(...(n["@graph"] as unknown[]));
      const me = n.mainEntity;
      if (Array.isArray(me)) stack.push(...me);
      else if (me) stack.push(me);

      const type = n["@type"];
      const isQuestion =
        (typeof type === "string" && /question/i.test(type)) ||
        (Array.isArray(type) && type.some((t) => typeof t === "string" && /question/i.test(t)));
      if (!isQuestion || typeof n.name !== "string") continue;

      const ans = Array.isArray(n.acceptedAnswer) ? n.acceptedAnswer[0] : n.acceptedAnswer;
      const answerText = ans && typeof ans === "object" ? (ans as Record<string, unknown>).text : undefined;
      if (typeof answerText !== "string") continue;

      const question = htmlToPlain(n.name);
      const answer = htmlToPlain(answerText);
      const key = question.toLowerCase();
      if (!question || !answer || seen.has(key)) continue;
      seen.add(key);
      out.push({ question: question.slice(0, 160), answer: answer.slice(0, 500) });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/** Merge FAQ lists, dedupe by question (case-insensitive), drop blanks, cap at 8. */
function mergeFaqs(...lists: FaqPair[][]): FaqPair[] {
  const seen = new Set<string>();
  const out: FaqPair[] = [];
  for (const f of lists.flat()) {
    const question = (f?.question || "").replace(/\s+/g, " ").trim();
    const answer = (f?.answer || "").replace(/\s+/g, " ").trim();
    if (question.length < 4 || answer.length < 2) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ question: question.slice(0, 160), answer: answer.slice(0, 500) });
    if (out.length >= 8) break;
  }
  return out;
}

/** Fall back to a visible <address> element when no structured data is available. */
function addressFromTag(html: string): string {
  const m = html.match(/<address[^>]*>([\s\S]*?)<\/address>/i);
  if (!m) return "";
  return m[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function extract(html: string, url: string) {
  const ogTitle = firstMatch(html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
    || firstMatch(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const title = firstMatch(html, /<title[^>]*>([^<]+)<\/title>/i);
  const rawName = ogTitle || title;
  const businessName = (rawName.split(/[|\-–—:]/)[0].trim() || businessNameFromUrl(url)).slice(0, 60);

  const description =
    firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    firstMatch(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) ||
    firstMatch(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);

  const services = pickServices(html, description);

  const ld = extractJsonLd(html);

  return {
    businessName,
    description: description.slice(0, 280),
    phone: pickPhone(html, ld.phone),
    email: pickEmail(html, siteHost(url), ld.email),
    address: decodeHtml(ld.address || addressFromTag(html)),
    services: services.map(decodeHtml),
    faqs: extractFaqJsonLd(html).map((f) => ({
      question: decodeHtml(f.question),
      answer: decodeHtml(f.answer),
    })),
  };
}

// Use a real browser User-Agent. A bot UA gets blocked (403) or the connection
// reset by Akamai/Cloudflare-protected sites (e.g. adidas.co.in), which makes
// fetchHtml throw and the scrape fall back to the manual-entry error.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Cap how much of a page we read. Some sites inline megabytes of base64 images
// (virtusconcrete.com.au ships ~20 MB), which blows past the fetch timeout if
// fully downloaded — but the useful HTML (<head>, headings, services) sits near
// the top, so the first couple of MB is enough.
const MAX_HTML_BYTES = 2_000_000;

async function fetchHtml(url: string, timeoutMs: number): Promise<string> {
  // SSRF guard: only fetch public http(s) hosts — never localhost, private
  // ranges, or the cloud metadata endpoint. Throws (→ scrape falls back to
  // manual entry) for anything internal.
  await assertPublicHttpUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    // Never treat an error page (404 / 403 / 5xx) as business content — its title
    // ("Page not found") and body would otherwise poison name/description/services.
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (!resp.body) return await resp.text();

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (bytes >= MAX_HTML_BYTES) {
        await reader.cancel();
        break;
      }
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

/** Strip a page down to readable visible text — what the deep analyser reads. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same-domain About / Services / Products links worth reading for deeper context. */
function internalLinks(html: string, baseUrl: string): string[] {
  const host = siteHost(baseUrl);
  const KEY = /about|service|product|solution|what-we|menu|shop|store|pricing|offerings|expertise/i;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'\s>]+)["']/gi)) {
    const href = m[1].trim();
    if (!KEY.test(href)) continue;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).toString().split("#")[0];
    } catch {
      continue;
    }
    if (siteHost(abs) !== host) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|css|js)$/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= 3) break;
  }
  return out;
}

/** Combine heuristic + LLM service lists: clean-ish, deduped (case-insensitive).
 *  Deliberately uncapped — see cleanServices. */
function mergeServices(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lists.flat()) {
    const t = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/^[-•*\s]+/, "").trim();
    if (t.length < 2 || t.length > 60) continue;
    const key = t.toLowerCase();
    if (NAV_JUNK.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** An AI-suggested call-handling rule (tailored to the business), editable later in the AI Brain. */
interface ScenarioPair {
  ifText: string;
  thenText: string;
}

/** Pull the first {...} JSON object out of an LLM reply (tolerant of code fences / preamble). */
function parseLlmJson(raw: string): {
  description?: string;
  services?: unknown;
  faqs?: unknown;
  scenarios?: unknown;
  businessHours?: unknown;
} {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return {};
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return {};
  }
}

/**
 * Deep analysis fallback: when the site doesn't clearly state its description or
 * services, read the full scraped text and have the LLM infer them. Returns blanks
 * (caller keeps its heuristic/generic values) if OpenAI isn't configured or fails.
 */
async function analyzeWithLLM(input: {
  url: string;
  businessName: string;
  pageText: string;
}): Promise<{ description: string; services: string[]; faqs: FaqPair[]; scenarios: ScenarioPair[]; businessHours: string }> {
  if (!integrationsStatus().openai) return { description: "", services: [], faqs: [], scenarios: [], businessHours: "" };
  try {
    const apiKey = getEffective("openai.apiKey");
    const model = getEffective("openai.model") || "gpt-5";

    const system =
      "You are setting up an AI phone receptionist for a business. The receptionist will answer " +
      "calls from THIS business's own customers, so it needs the genuine list of services/offerings " +
      "those callers would ask about. Analyse the business from its website and reply with STRICT JSON " +
      'only, no prose: {"description": string, "services": string[], "faqs": {"question": string, "answer": string}[], "scenarios": {"ifText": string, "thenText": string}[], "businessHours": string}.\n' +
      '"description": 2-3 plain, accurate sentences on who the business is and what they do. Write it ' +
      "factually, the way you'd brief a new receptionist on their first day — strip the site's marketing " +
      'voice, slogans and superlatives ("leading", "premier", "trusted", "award-winning").\n' +
      '"services": a COMPREHENSIVE, genuine list (list EVERY distinct offering — don\'t artificially limit ' +
      "the count) of the concrete PRODUCTS and SERVICES this business sells to ITS CUSTOMERS — the things a " +
      "customer can actually buy, order, book or subscribe to, and would call to ask about. " +
      "RELEVANCE TEST — apply this to EVERY entry before you include it: would a real customer ring this " +
      "business up and ask about THIS, by name? If a phone receptionist would never be asked about it, or " +
      "could not do anything about it, leave it out — no matter how prominently the website features it. " +
      "You are briefing a receptionist for live phone calls, not rebuilding the site's sitemap. " +
      "First work out what KIND of business this is (from the name, URL and page content), then list what a " +
      "business of that type genuinely offers its customers, combining what the page shows with well-known, " +
      "real offerings for that industry. List the distinct product lines / offerings themselves (not every " +
      "minor internal feature of one product). Be specific and customer-facing. Examples: a footwear/apparel " +
      'retailer → "Men\'s footwear", "Women\'s clothing", "Kids\' wear", "Order tracking", "Returns & exchange", ' +
      '"Cash on delivery", "Size guide", "Store locator"; a software company → its actual products/platforms ' +
      'and plans, e.g. "CRM", "Helpdesk / Ticketing", "AI calling platform", "Custom software development". ' +
      "Every item must be a REAL product or service a customer can buy or use.\n" +
      "STRICTLY EXCLUDE website UI / navigation / menu / account / call-to-action labels — they are NOT services. " +
      'Never output things like: "Home", "About <brand>", "Contact", "Login", "Sign up", "Menu", "Search", ' +
      '"Choose your option", "Select an option", "Call us", "Get help", "Collection", "Category", "Shop now", ' +
      '"Read more", "Learn more", "Newsletter", cookie/privacy notices, or any bare navigation word.\n' +
      "ALSO STRICTLY EXCLUDE marketing and SEO filler — most sites are stuffed with it for search ranking, " +
      "and it is worthless to a receptionist. Never output: taglines or slogans; keyword-stuffed phrases " +
      'written for Google rather than customers ("best <service> in <city>", "affordable", "trusted", "#1", ' +
      '"near me", "24/7 <keyword>"); selling points and benefit claims ("free quotes", "fast turnaround", ' +
      '"100% satisfaction guaranteed", "fully insured", "licensed and certified", "family owned", "award ' +
      'winning", "years of experience"); awards, certifications, accreditations, partner or supplier brand ' +
      'names; payment/finance/delivery marketing ("buy now pay later", "free shipping"); social media, ' +
      "reviews and testimonials; and vague industry buzzwords that name nothing a customer can actually buy. " +
      "If an entry reads like it was written to rank on a search engine rather than to answer a phone call, " +
      "drop it. A shorter, genuinely useful list always beats a padded one.\n" +
      '"faqs": at most 3 question-and-answer pairs. FIRST use Q&A ACTUALLY present on the site (an FAQ ' +
      "section, hours, pricing, booking or policy questions) — use the answer as stated. Skip any on-site " +
      'Q&A that exists to sell or to rank rather than to help a caller ("Why choose us?", "What makes you ' +
      'the best?", "Are you the top-rated <service> in <city>?") — a receptionist is never asked those. ' +
      "Pick the ones a real person on the phone would actually ask. If the site has no " +
      "FAQ content, SUGGEST up to 3 FAQs a caller would realistically ask THIS business — but ground every " +
      "question AND answer strictly in the provided website content: its actual services, industry and the " +
      "facts on the page. NEVER state a fact the site doesn't give — no invented prices, opening hours, " +
      "addresses, guarantees, turnaround times or policies. If a typical caller question can't be answered " +
      "from the site's content, either answer it safely without asserting unstated facts (e.g. \"Yes — we " +
      'handle <service from the site>; the team will confirm the details on a callback") or leave that ' +
      "question out. These answers are SPOKEN by a phone receptionist, so keep every answer to what a person " +
      "would actually say out loud — at most 2 short sentences. Never pack an answer with a run of options, " +
      "durations or prices (no \"A – 30 mins; B – 45 mins; C – 60 mins\"); give the single most useful fact and " +
      "leave the rest for the team to confirm. Return [] only when the content is too thin to ground anything.\n" +
      '"scenarios": at most 3 call-handling rules TAILORED to this kind of business — the 3 most common situations this ' +
      'receptionist will face on a call and how to handle each. Each item is {"ifText": <the situation>, ' +
      '"thenText": <what the receptionist should do>}. ifText is a short condition (e.g. "the caller wants to ' +
      'book an appointment", "the caller is asking about an existing order/delivery", "it\'s an emergency"); ' +
      "thenText is the concise action (e.g. \"collect their name, preferred date and the service needed, then " +
      'confirm the booking"). thenText MUST be under 20 words and describe only the OUTCOME to reach. NEVER ' +
      'tell the receptionist to "outline", "list", "explain", "detail" or "run through" anything — this is a ' +
      "live phone call, and those words make it read a list aloud at the caller. " +
      "Make them SPECIFIC to the business type — e.g. a restaurant: table reservations, " +
      "takeaway orders, opening hours, large-group bookings; a plumber/tradie: emergency callouts, booking a " +
      "site visit, giving a quote, existing-job follow-ups; a clinic: booking appointments, prescription " +
      "refills, urgent cases. Don't include generic UI/navigation items.\n" +
      '"businessHours": the business\'s opening/trading hours, ONLY IF the website actually states them (an ' +
      '"Opening hours" / "Hours" / "We\'re open" section, footer, or contact page). Return them as a single ' +
      'concise line, e.g. "Monday to Friday, 9:00am – 5:00pm. Closed weekends." NEVER invent or guess hours — ' +
      'if the site does not clearly state its hours, return "" (empty string).\n' +
      "Ground the description and FAQs in the provided content (don't fabricate facts). For services you MAY " +
      "infer the typical genuine offerings of the business's industry. If the provided website content is thin, " +
      "bot-blocked or mostly navigation BUT you clearly recognise this business/brand from its name and URL " +
      "(e.g. a well-known site like amazon.in), list its well-known, real customer-facing services and a short " +
      "factual description from your own knowledge. Only return empty values when you neither have usable " +
      "content NOR recognise the business — never invent a business that doesn't exist.";

    const content = `Website: ${input.url}\nBusiness name: ${input.businessName}\n\nWebsite content:\n${input.pageText.slice(0, 18000)}`;

    // Two attempts: a transient OpenAI error (429/timeout) or a truncated/unparseable
    // JSON reply used to silently zero out the whole extraction for that run — the
    // main reason the SAME website returned services/FAQs one time and nothing the
    // next. An all-empty parse counts as a failed attempt too (truncation looks
    // exactly like that), so it gets one more try before we fall back.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await traceFetch("openai", "https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(
            buildChatBody({
              model,
              messages: [
                { role: "system", content: system },
                { role: "user", content },
              ],
              // Enough headroom for a long service list — a reply cut off mid-JSON
              // parses to {} and looks like "the site has nothing".
              maxTokens: 3000,
              // Deterministic: the same site content should extract the same list.
              temperature: 0,
              // Strict JSON out (the prompt already asks for JSON). "minimal" reasoning
              // (matching every other LLM call in the app) — on a gpt-5 reasoning model
              // "low" added a large, fixed thinking delay that made this public analyze
              // endpoint feel slow regardless of site size. Structured extraction from
              // the provided page text doesn't need deeper reasoning.
              jsonObject: true,
              reasoningEffort: "minimal",
            }),
          ),
        }, { unitsFromResponse: openAiTokenUnits });
        if (!res.ok) {
          // Surface the upstream reason (e.g. the model isn't enabled on this key) in
          // the server logs instead of silently returning empty → generic 422.
          const detail = await res.text().catch(() => "");
          throw new Error(`OpenAI error ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
        }

        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const parsed = parseLlmJson(data.choices?.[0]?.message?.content?.trim() || "");
        const services = Array.isArray(parsed.services)
          ? parsed.services.filter((s): s is string => typeof s === "string")
          : [];
        const faqs = Array.isArray(parsed.faqs)
          ? parsed.faqs.flatMap((f) =>
              f && typeof f === "object" &&
              typeof (f as Record<string, unknown>).question === "string" &&
              typeof (f as Record<string, unknown>).answer === "string"
                ? [{
                    question: (f as Record<string, string>).question,
                    answer: (f as Record<string, string>).answer,
                  }]
                : [],
            ).slice(0, 3)
          : [];
        const scenarios = Array.isArray(parsed.scenarios)
          ? parsed.scenarios.flatMap((s) =>
              s && typeof s === "object" &&
              typeof (s as Record<string, unknown>).ifText === "string" &&
              typeof (s as Record<string, unknown>).thenText === "string"
                ? [{
                    ifText: capFirst((s as Record<string, string>).ifText.trim()),
                    thenText: capFirst((s as Record<string, string>).thenText.trim()),
                  }]
                : [],
            ).filter((s) => s.ifText && s.thenText).slice(0, 3)
          : [];
        const description = (parsed.description || "").trim();
        const businessHours =
          typeof parsed.businessHours === "string" ? parsed.businessHours.trim() : "";
        if (description || services.length || faqs.length || businessHours) {
          return { description, services, faqs, scenarios, businessHours };
        }
        // Parsed to nothing (likely a truncated/garbled reply) — retry once.
        console.warn(`[onboard] analyzeWithLLM attempt ${attempt + 1} parsed empty; retrying`);
      } catch (e) {
        console.error(
          `[onboard] analyzeWithLLM attempt ${attempt + 1} failed:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  } catch (e) {
    console.error("[onboard] analyzeWithLLM failed:", e instanceof Error ? e.message : e);
  }
  return { description: "", services: [], faqs: [], scenarios: [], businessHours: "" };
}

/**
 * Take the heuristic extraction and deepen it: when the site doesn't clearly state
 * its description or services, analyse the real scraped text via the LLM. Returns
 * whatever could actually be determined — NO fabricated/generic placeholders, so an
 * empty description+services signals "nothing found" to the caller.
 */
async function enrichResult(
  base: ReturnType<typeof extract>,
  url: string,
  pageText: string,
) {
  let description = base.description;
  let services = base.services;
  let faqs = base.faqs;

  const descriptionWeak = !description || description.length < 40;

  // Always deep-analyse via the LLM (not gated on scraped text length). The
  // heuristic <li>/<h2> scrape grabs nav/menu labels as "services" on SPA /
  // e-commerce homepages (e.g. "Choose your option", "Call us", "Collection"), so
  // the LLM — which reasons about the business type and returns genuine
  // customer-facing services — is the source of truth. It also recognises
  // well-known brands from the name/URL even when the page is JS-heavy or
  // bot-blocked (e.g. amazon.in), and returns empty only when it neither has
  // usable content nor recognises the business. (analyzeWithLLM no-ops without
  // an OpenAI key, falling back to the heuristic below.)
  const llm = await analyzeWithLLM({ url, businessName: base.businessName, pageText });
  if (descriptionWeak && llm.description) description = llm.description;
  // Prefer the LLM's (cleaned) services over the nav-polluted heuristic ones.
  if (llm.services.length) services = mergeServices(llm.services);
  if (llm.faqs.length) faqs = mergeFaqs(faqs, llm.faqs);

  // Derive services from the real description as a last source — still grounded in
  // actual content, not a generic placeholder.
  if (!services.length) services = servicesFromDescription(description);

  // AI-suggested, business-specific call-handling rules. Seeded into the agent's
  // Scenario Handling at onboarding so it isn't a one-size-fits-all default; the
  // owner can edit/add/remove them later in the AI Brain.
  const scenarios: ScenarioPair[] = llm.scenarios ?? [];

  // Opening hours, ONLY when the site actually stated them. Empty otherwise so the
  // client keeps its 9–5 default rather than showing invented hours.
  const businessHours = llm.businessHours ?? "";

  return { ...base, description: description.slice(0, 400), services, faqs, scenarios, businessHours };
}

/** POST /api/onboard/analyze — scrape a website, deep-analyse it, return business info (public). */
router.post(
  "/analyze",
  rateLimit({ windowMs: 60_000, max: 20 }),
  asyncHandler(async (req, res) => {
    const { url } = z.object({ url: z.string().min(3) }).parse(req.body);
    const normalized = /^https?:\/\//i.test(url) ? url.trim() : `https://${url.trim()}`;

    // 1) Validate the URL first — a malformed address never gets scraped.
    let valid = false;
    try {
      const u = new URL(normalized);
      valid = (u.protocol === "http:" || u.protocol === "https:") && /\.[a-z]{2,}$/i.test(u.hostname);
    } catch {
      valid = false;
    }
    if (!valid) {
      return res
        .status(400)
        .json({ error: "That doesn't look like a valid website address. Please check it and try again." });
    }

    // 2) Fetch the site. Retry ONLY a genuine timeout: a slow-but-fine site
    // deserves one more, slightly longer try. A definitive block (403 / blocked
    // page / reset — as Akamai/Cloudflare sites like adidas serve) won't improve
    // on retry, so we don't burn another ~15s on it.
    //
    // Crucially, we do NOT hard-fail when scraping yields nothing. We still run
    // the LLM with the URL + business name so it can fall back to brand
    // recognition for well-known businesses (e.g. adidas, amazon.in) — the same
    // way ChatGPT identifies them from the domain alone. Genuinely unknown sites
    // produce no content and no recognition, and get the 422 at step 3 below.
    let html = "";
    try {
      html = await fetchHtml(normalized, 8000);
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      if (timedOut) {
        try {
          html = await fetchHtml(normalized, 12000);
        } catch {
          html = "";
        }
      }
    }

    const base = extract(html, normalized);

    // Read a few key internal pages (About / Services / Products) so the deep
    // analysis sees the whole site, not just the landing page. Best-effort and
    // parallel; these block the LLM step, so keep the per-page timeout tight —
    // a single slow subpage shouldn't stall the whole analyze request. The
    // landing page alone is enough to extract from if a subpage times out.
    const extras = await Promise.allSettled(
      internalLinks(html, normalized).map((link) => fetchHtml(link, 6000)),
    );
    const pages = [html, ...extras.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))];
    // Give every fetched page a guaranteed share of the LLM's text window. A flat
    // slice let a long homepage (nav/footer noise) crowd the About/Services/FAQ
    // pages out entirely — the homepage gets 6k chars, each subpage 4k, matching
    // the 18k cap in analyzeWithLLM.
    const pageTexts = pages.map(htmlToText).filter(Boolean);
    const pageText = [pageTexts[0]?.slice(0, 6000), ...pageTexts.slice(1).map((t) => t.slice(0, 4000))]
      .filter(Boolean)
      .join("\n\n");

    const result = await enrichResult(base, normalized, pageText);

    // 3) Nothing real could be determined — don't invent generic placeholders.
    // Signal failure so the UI leaves the fields empty and shows an error.
    if (!result.description && result.services.length === 0) {
      return res.status(422).json({
        error: "We couldn't find enough information on that website. Please enter your business details manually.",
      });
    }

    return res.json(result);
  }),
);

/** POST /api/onboard/validate — check that a domain actually resolves and responds (public). */
router.post(
  "/validate",
  asyncHandler(async (req, res) => {
    const { url } = z.object({ url: z.string().min(3) }).parse(req.body);
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;

    // SSRF guard: a public reachability probe must not become a way to scan
    // internal hosts. Reject anything that resolves to a non-public address.
    if (!(await isPublicHttpUrl(normalized))) {
      return res.json({ reachable: false });
    }

    // Use a real browser User-Agent. Sites behind Akamai/Cloudflare bot
    // protection (e.g. adidas.co.in) reject non-browser UAs — often by
    // resetting the connection, which would make fetch throw below.
    const BROWSER_UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(normalized, {
        method: "GET",
        signal: controller.signal,
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
      });
      clearTimeout(timer);
      // Any HTTP response (even 4xx/5xx) means the host exists.
      return res.json({ reachable: resp.status > 0 });
    } catch (err) {
      // Only a genuine DNS-resolution failure means the site doesn't exist.
      // A timeout, connection reset, or bot-block means the host is up but
      // refusing us — that's still a reachable website, so don't false-negative.
      const code =
        (err as { cause?: { code?: string }; code?: string } | undefined)?.cause?.code ??
        (err as { code?: string } | undefined)?.code;
      const dnsFail = code === "ENOTFOUND" || code === "EAI_AGAIN";
      return res.json({ reachable: !dnsFail });
    }
  }),
);

export default router;
