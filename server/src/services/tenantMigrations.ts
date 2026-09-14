import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Applies prisma/tenant to one tenant DB via the real `prisma migrate deploy` (so each
// tenant keeps its own _prisma_migrations history) — that's why the CLI is a runtime dep.

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

/** Migrates one tenant DB to the newest migration. `directUrl` must be unpooled — migrations take a session advisory lock a transaction-mode pooler can't hold. */
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
