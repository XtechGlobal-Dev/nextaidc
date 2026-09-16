import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Applies prisma/tenant to one tenant DB via the real `prisma migrate deploy` (so each
// tenant keeps its own _prisma_migrations history) — that's why the CLI is a runtime dep.

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

/**
 * `prisma/tenant`, found by walking up from this file rather than counting
 * directories.
 *
 * This module is loaded both from source (scripts/tenantMigrate.ts, via tsx)
 * and from the compiled tree, and those are no longer the same depth: the emit
 * root became the repo root when ../shared/contracts joined the build, so what
 * used to land in dist/services/ now lands in dist/server/src/services/. A
 * counted `../..` was right for one and quietly wrong for the other — it
 * resolved to a dist/ path that does not exist, which surfaced as Prisma's
 * "Could not load --schema" on provisioning and a bare ENOENT (HTTP 500) on
 * any brand route that reads the schema version. Searching upward is immune to
 * wherever the output tree moves next.
 *
 * prisma/ is excluded from the build and never copied into dist, so the answer
 * always lives in the source tree above this file.
 *
 * Resolved on first use rather than at import: a tree that genuinely lacks the
 * directory should fail where tenants are touched, not stop the API booting.
 */
let cachedPrismaDir = "";
export function tenantPrismaDir(): string {
  if (cachedPrismaDir) return cachedPrismaDir;
  for (let dir = HERE; ; dir = dirname(dir)) {
    const candidate = join(dir, "prisma", "tenant");
    if (existsSync(join(candidate, "schema.prisma"))) return (cachedPrismaDir = candidate);
    if (dirname(dir) === dir) break;
  }
  throw new Error(
    `prisma/tenant/schema.prisma not found in any directory above ${HERE}. ` +
      `It ships with the repo and is never copied into dist — check that ` +
      `server/prisma/tenant exists in the deployed tree.`,
  );
}

/** The tenant datamodel the Prisma CLI is pointed at. */
export function tenantSchemaPath(): string {
  return join(tenantPrismaDir(), "schema.prisma");
}

/** Every tenant migration on disk, oldest first. */
export function tenantMigrationNames(): string[] {
  const dir = join(tenantPrismaDir(), "migrations");
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
      [prismaCliEntry(), "migrate", "deploy", "--schema", tenantSchemaPath()],
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
