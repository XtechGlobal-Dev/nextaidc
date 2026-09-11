/**
 * Per-country "regional style" persona blocks. These make the live assistant
 * SOUND local to the caller's country — an Australian caller hears an assistant
 * that talks like an Aussie receptionist, an American caller hears an American
 * one, and so on. This builds familiarity and trust on the first call.
 *
 * Scope on purpose: these are the REGIONAL DELTA only — the country-specific
 * word choices and acknowledgements. The generic style (be brief, ask one
 * question at a time, never interrupt…) already lives in the master prompt's
 * `## CONVERSATION STYLE` block, so we don't repeat it here.
 *
 * NOTE: word choice is all a text prompt can control. The audible ACCENT comes
 * from the TTS voice, not the prompt — a US-voiced assistant saying "no worries"
 * still sounds American. Mapping country → voice is a separate, future concern.
 *
 * These are the built-in defaults for the English-speaking markets where local
 * phrasing actually differs. An admin can override or extend them per country
 * via the `prompt.countryStyles` platform setting (see services/settings.ts).
 */
export const BUILTIN_COUNTRY_STYLES: Record<string, string> = {
  AU: [
    "Sound like an experienced Australian receptionist.",
    'Use natural spoken Australian English with contractions and easygoing acknowledgements like "no worries", "too easy", "got it" or "alrighty" — keep it warm and professional, never overdone.',
  ].join("\n"),
  US: [
    "Sound like an experienced American receptionist.",
    'Use natural spoken American English with contractions and warm acknowledgements like "sure thing", "got it", "no problem" or "absolutely".',
  ].join("\n"),
  GB: [
    "Sound like an experienced British receptionist.",
    'Use natural spoken British English with contractions and polite acknowledgements like "of course", "no problem", "right you are" or "lovely".',
  ].join("\n"),
  CA: [
    "Sound like an experienced Canadian receptionist.",
    'Use natural spoken Canadian English with contractions and friendly acknowledgements like "for sure", "no problem", "you bet" or "sounds good".',
  ].join("\n"),
  NZ: [
    "Sound like an experienced New Zealand receptionist.",
    'Use natural spoken New Zealand English with contractions and easygoing acknowledgements like "no worries", "sweet as", "too easy" or "all good".',
  ].join("\n"),
  IN: [
    "Sound like an experienced Indian receptionist.",
    'Use natural spoken Indian English with contractions and courteous acknowledgements like "sure", "of course", "no problem" or "right away". Stay warm, polite and respectful.',
  ].join("\n"),
};

/** Normalise a stored country to an uppercase ISO 3166-1 alpha-2 code, or "" if
 *  absent/invalid. Everything downstream keys country styles by this form. */
export function normalizeCountry(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

/** Wrap resolved style text into the `## REGIONAL STYLE` prompt section, or ""
 *  when there's no style for the country (→ no section is appended, neutral). */
export function regionalStyleSection(styleText: string): string {
  const body = styleText.trim();
  return body ? `## REGIONAL STYLE\n${body}` : "";
}
