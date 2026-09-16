import { env } from "../env.js";

// Neon control-plane API for per-tenant Postgres projects. Plain fetch on purpose.
// The key can DELETE any project: env only, never admin settings, never returned to callers.

const API = "https://console.neon.tech/api/v2";

export function isNeonConfigured(): boolean {
  return Boolean(env.NEON_API_KEY);
}

export interface NeonProject {
  projectId: string;
  region: string;
  /** Pooled connection string — what the app queries through. */
  url: string;
  /** Direct, unpooled — DDL and anything taking a session-level lock. */
  directUrl: string;
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<T> {
  if (!isNeonConfigured()) {
    throw new Error("Neon is not configured — set NEON_API_KEY in server/.env.");
  }
  const res = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${env.NEON_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    // Neon puts the useful part in `message`; fall back to the raw body. The
    // API key never appears in either, so this is safe to surface to an admin.
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch {
      /* not JSON — keep the raw prefix */
    }
    throw new Error(`Neon API ${init.method} ${path} failed (${res.status}): ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Pull the pooled and direct URIs out of a create-project response. */
function splitUris(uris: { connection_uri: string }[]): { url: string; directUrl: string } {
  const direct = uris.find((u) => !u.connection_uri.includes("-pooler."))?.connection_uri;
  const pooled = uris.find((u) => u.connection_uri.includes("-pooler."))?.connection_uri;
  // Some plans return only the direct URI; `-pooler` before the host's first dot
  // is Neon's documented transformation, and the reverse for direct.
  const directUrl = direct ?? (pooled ? pooled.replace("-pooler.", ".") : "");
  const url = pooled ?? (direct ? direct.replace(/(@[^.]+)\./, "$1-pooler.") : "");
  if (!url || !directUrl) throw new Error("Neon returned no usable connection URI.");
  return { url, directUrl };
}

/** Creates a brand's Neon project. `region` is a residency promise — passed through verbatim, never defaulted silently. */
export async function createTenantProject(
  brandSlug: string,
  region: string,
): Promise<NeonProject> {
  const body = {
    project: {
      // Prefixed so a project belonging to a tenant is obvious in the Neon
      // console next to the platform's own.
      name: `tenant-${brandSlug}`.slice(0, 60),
      ...(region ? { region_id: region } : {}),
    },
  };
  const data = await call<{
    project: { id: string; region_id: string };
    connection_uris: { connection_uri: string }[];
  }>("/projects", { method: "POST", body });

  const { url, directUrl } = splitUris(data.connection_uris ?? []);
  return {
    projectId: data.project.id,
    region: data.project.region_id ?? region,
    url,
    directUrl,
  };
}

/** Destroys the tenant's entire history, irreversibly. Explicit admin action only — nothing calls this automatically. */
export async function deleteTenantProject(projectId: string): Promise<void> {
  await call(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
}

/** Live region list for the residency picker, so nothing hardcoded goes stale. */
export async function listRegions(): Promise<{ id: string; name: string }[]> {
  const data = await call<{ regions?: { region_id: string; name: string }[] }>("/regions");
  return (data.regions ?? []).map((r) => ({ id: r.region_id, name: r.name }));
}
