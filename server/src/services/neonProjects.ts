import { env } from "../env.js";

/* ------------------------------------------------------------------ *
 *  Neon control-plane API — creating and destroying the Postgres
 *  project that backs one isolated tenant.
 *
 *  Plain fetch rather than a client library: three endpoints are needed and a
 *  dependency that can provision and delete customer databases is a large
 *  surface to take on for that.
 *
 *  The API key here can create and DELETE any project on the account. It is
 *  read from the environment only, never from admin settings, and never
 *  returned to any caller.
 * ------------------------------------------------------------------ */

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
  // Neon has returned only the direct URI on some plans. Deriving the pooled
  // host is the documented transformation (insert `-pooler` before the first
  // dot of the host), and deriving direct from pooled is the reverse.
  const directUrl = direct ?? (pooled ? pooled.replace("-pooler.", ".") : "");
  const url = pooled ?? (direct ? direct.replace(/(@[^.]+)\./, "$1-pooler.") : "");
  if (!url || !directUrl) throw new Error("Neon returned no usable connection URI.");
  return { url, directUrl };
}

/**
 * Create a dedicated Neon project for a brand.
 *
 * `region` is the contractual part — a residency clause names a jurisdiction,
 * and this is where that promise is actually kept, so it is passed through
 * verbatim rather than defaulted silently.
 */
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

/**
 * Permanently delete a tenant's Neon project.
 *
 * This destroys the customer's entire call history and cannot be undone, so
 * nothing calls it automatically — decommissioning is an explicit admin action
 * that requires the brand's data to have been exported or migrated back first.
 */
export async function deleteTenantProject(projectId: string): Promise<void> {
  await call(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
}

/** Regions the account may create projects in — the picker an admin chooses a
 *  residency region from, rather than a hardcoded list that goes stale. */
export async function listRegions(): Promise<{ id: string; name: string }[]> {
  const data = await call<{ regions?: { region_id: string; name: string }[] }>("/regions");
  return (data.regions ?? []).map((r) => ({ id: r.region_id, name: r.name }));
}
