import "dotenv/config";
// A brand's workspace lives in the brand's database (phase 6): BRAND=<slug> picks it.
import { prisma } from "./_brandDb.js";

const conv = await prisma.conversion.findFirst({
  where: { vapiAssistantId: "ea2aead6-9a5c-401b-b218-f66ca544775e" },
  select: { id: true, status: true, vapiAssistantId: true, agentConfig: true },
});
if (!conv) {
  console.log("No conversion found for that assistant id.");
} else {
  const cfg = conv.agentConfig as { identity?: { voiceId?: string } };
  console.log("conversion:", conv.id, "status:", conv.status);
  console.log("DB agentConfig.identity.voiceId =", JSON.stringify(cfg.identity?.voiceId));
}
await prisma.$disconnect();
