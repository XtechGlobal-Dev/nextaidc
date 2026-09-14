/** Per-country regional style — word choice only (the generic style lives in CONVERSATION STYLE, and
 *  accent comes from the TTS voice, not the prompt). Admin-overridable via `prompt.countryStyles`. */
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
