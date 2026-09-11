/* One-off: add the 3 requested Australian Voice-Library voices to our ElevenLabs
 * account so they play in /api/tts and on Vapi, then verify they resolve. */
import { loadSettings, getEffective } from "../src/services/settings.js";

const TO_ADD = [
  { id: "9B2Vd5yQ7rKaqNmzGdy1", owner: "e33eb547f8af39719b57253a6230915455d19c17d3f7781cabe273337a2e5df2", name: "Steve" },
  { id: "tyepWYJJwJM9TTFIg5U7", owner: "1be9e02685a63c678b525995c8a5b35ed27f301b40ed227719451b7da443ee76", name: "Clara" },
  { id: "gEdKKVxVhNCulBgRQ9GW", owner: "95351b707d051cacc56af2c38fa083807ce5bda3d1f6db34b91d58e95c3d8858", name: "Charlotte" },
];

async function main() {
  await loadSettings();
  const apiKey = getEffective("elevenlabs.apiKey");
  if (!apiKey) throw new Error("No ElevenLabs API key configured.");
  const headers = { "xi-api-key": apiKey, "content-type": "application/json" };

  for (const v of TO_ADD) {
    const r = await fetch(`https://api.elevenlabs.io/v1/voices/add/${v.owner}/${v.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ new_name: v.name }),
    });
    const body = await r.text();
    console.log(`add ${v.name} (${v.id}): HTTP ${r.status} ${body.slice(0, 200)}`);
  }

  // Verify each id now resolves against the account.
  for (const v of TO_ADD) {
    const r = await fetch(`https://api.elevenlabs.io/v1/voices/${v.id}`, { headers: { "xi-api-key": apiKey } });
    if (r.ok) {
      const d = (await r.json()) as any;
      console.log(`VERIFIED: ${v.id} → ${d.name} [${d.category}] gender=${d.labels?.gender}`);
    } else {
      console.log(`FAILED verify: ${v.id} HTTP ${r.status}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
