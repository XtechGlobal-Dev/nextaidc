/* One-off: verify 4 requested Australian voice ids — are they in the account
 * already? If not, locate them in the shared Voice Library (to get the
 * public_owner_id needed to add them). Prints no secrets. */
import { loadSettings, getEffective } from "../src/services/settings.js";

const WANTED = [
  "snyKKuaGYk1VUEh42zbW", // male
  "9B2Vd5yQ7rKaqNmzGdy1", // male
  "tyepWYJJwJM9TTFIg5U7", // female
  "gEdKKVxVhNCulBgRQ9GW", // female
];

async function main() {
  await loadSettings();
  const apiKey = getEffective("elevenlabs.apiKey");
  if (!apiKey) throw new Error("No ElevenLabs API key configured.");
  const headers = { "xi-api-key": apiKey };

  const missing: string[] = [];
  for (const id of WANTED) {
    const r = await fetch(`https://api.elevenlabs.io/v1/voices/${id}`, { headers });
    if (r.ok) {
      const v = (await r.json()) as any;
      console.log(
        `IN ACCOUNT: ${id}  ${v.name}  [${v.category}]  gender=${v.labels?.gender}  accent=${v.labels?.accent}  desc=${v.labels?.description ?? v.description ?? ""}`,
      );
    } else {
      console.log(`NOT in account: ${id} (HTTP ${r.status})`);
      missing.push(id);
    }
  }

  if (!missing.length) return;
  console.log("\nScanning shared Voice Library for the missing ids…");
  const found = new Map<string, any>();
  for (const gender of ["male", "female"]) {
    for (let page = 0; page < 10 && found.size < missing.length; page++) {
      const url = new URL("https://api.elevenlabs.io/v1/shared-voices");
      url.searchParams.set("page_size", "100");
      url.searchParams.set("language", "en");
      url.searchParams.set("accent", "australian");
      url.searchParams.set("gender", gender);
      url.searchParams.set("page", String(page));
      const r = await fetch(url, { headers });
      if (!r.ok) { console.log(`shared-voices ${gender} p${page}: HTTP ${r.status}`); break; }
      const data = (await r.json()) as { voices?: any[]; has_more?: boolean };
      for (const v of data.voices ?? []) {
        if (missing.includes(v.voice_id)) found.set(v.voice_id, v);
      }
      if (!data.has_more) break;
    }
  }
  for (const id of missing) {
    const v = found.get(id);
    if (v) {
      console.log(
        `LIBRARY: ${id}  ${v.name}  owner=${v.public_owner_id}  gender=${v.gender}  age=${v.age}  usecase=${v.use_case}  desc=${(v.description ?? "").slice(0, 100)}`,
      );
    } else {
      console.log(`NOT FOUND in en/australian library scan: ${id}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
