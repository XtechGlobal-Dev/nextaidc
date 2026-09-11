import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* ------------------------------------------------------------------ *
 *  Applying the tenant schema (prisma/tenant) to one database.
 *
 *  The real `prisma migrate deploy`, not a hand-rolled runner: every tenant
 *  then carries its own `_prisma_migrations` history, checksums and
 *  failed-state handling, exactly like the control plane. The CLI is a
 *  runtime dependency for that reason.
 *
 *  A tenant's version is simply the name of the newest migration applied;
 *  `latestTenantMigration()` is what "current" means.
 * ------------------------------------------------------------------ */

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

/** `prisma/tenant`, from both src/services and dist/services (same depth). */
export const TENANT_PRISMA_DIR = join(HERE, "..", "..", "prisma", "tenant");
export const TENANT_SCHEMA_PATH = join(TENANT_PRISMA_DIR, "schema.prisma");

/** Every tenant migration on disk, oldest first. */
export function tenantMigrationNames(): string[] {
  const dir = join(TENANT_PRISMA_DIR, "migrations");
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/** The version a fully migrated tenant is at. */
export function latestTenantMigration(): string {
  const names = tenantMigrationNames();
  return names[names.length - 1] ?? "";
}

/** The Prisma CLI's entry point inside node_modules, run with this same Node —
 *  no PATH lookups, no npx, so it works the same on Render and on Windows. */
function prismaCliEntry(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("prisma/build/index.js");
  } catch {
    return join(dirname(require.resolve("prisma/package.json")), "build", "index.js");
  }
}

/**
 * Bring one tenant database up to the newest migration.
 *
 * `directUrl` is the unpooled endpoint: migrations take a session-level
 * advisory lock a transaction-mode pooler cannot hold. Returns the CLI's output
 * for the provisioning log; throws with it when the deploy fails.
 */
export async function deployTenantMigrations(directUrl: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [prismaCliEntry(), "migrate", "deploy", "--schema", TENANT_SCHEMA_PATH],
      {
        env: { ...process.env, TENANT_DATABASE_URL: directUrl, TENANT_DIRECT_URL: directUrl },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return `${stdout}\n${stderr}`.trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    // The CLI's own explanation is the useful part; strip the connection string
    // in case a message echoes it.
    const detail = `${err.stderr ?? ""}\n${err.stdout ?? ""}`.trim() || err.message || String(e);
    throw new Error(`tenant migrate deploy failed: ${detail.replace(/postgres(ql)?:\/\/\S+/g, "postgresql://***")}`);
  }
}
