#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 *  Root dev orchestrator — run with `npm run dev`.
 *  1. Installs/refreshes dependencies (frontend + backend)
 *  2. Generates the Prisma client + applies DB schema/migrations
 *     (only when a Postgres DATABASE_URL is configured in server/.env)
 *  3. Starts the backend (Express) and frontend (Vite) together
 * ------------------------------------------------------------------ */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "server");

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function run(label, cmd, cwd = root) {
  console.log(`\n${cyan("▸ " + label)}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

/** Kill whatever process is listening on the given TCP ports. Best-effort and
 *  cross-platform — on Windows, `concurrently`'s SIGTERM frequently fails to
 *  reap the vite/tsx grandchildren, leaving the port held so the next
 *  `npm run dev` dies with "Port already in use". Clearing them first makes
 *  startup self-healing. Never throws. */
function freePorts(ports) {
  const isWin = process.platform === "win32";
  const pids = new Set();
  for (const port of ports) {
    try {
      if (isWin) {
        // Get-NetTCPConnection reports the owning PID reliably; parsing netstat
        // text is brittle (the port can match the wrong address column).
        const out = execSync(
          `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
          { stdio: ["ignore", "pipe", "ignore"] },
        ).toString();
        for (const pid of out.split("\n")) {
          const t = pid.trim();
          if (/^\d+$/.test(t) && t !== "0") pids.add(t);
        }
      } else {
        const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
          stdio: ["ignore", "pipe", "ignore"],
        }).toString();
        for (const pid of out.split("\n")) if (pid.trim()) pids.add(pid.trim());
      }
    } catch {
      // no listener on this port — nothing to free.
    }
  }
  if (!pids.size) return;
  console.log(`\n${cyan("▸ Freeing dev ports")} ${yellow(ports.join(", "))} — killing ${[...pids].join(", ")}`);
  for (const pid of pids) {
    try {
      execSync(isWin ? `taskkill /PID ${pid} /T /F` : `kill -9 ${pid}`, { stdio: "ignore" });
    } catch {
      // already gone / not ours — ignore.
    }
  }
}

/** Read a single KEY=value from a .env file (unquoted value). */
function readEnvVar(file, key) {
  if (!existsSync(file)) return "";
  const m = readFileSync(file, "utf8").match(new RegExp(`^\\s*${key}\\s*=\\s*["']?([^"'\\n]*)`, "m"));
  return m ? m[1].trim() : "";
}

/** Set/replace KEY="value" in a .env file. */
function upsertEnvVar(file, key, value) {
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `${key}="${value}"`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  content = re.test(content) ? content.replace(re, line) : `${content.replace(/\s*$/, "")}\n${line}\n`;
  writeFileSync(file, content);
}

/** Make sure DIRECT_URL exists, deriving it from DATABASE_URL when it doesn't.
 *  schema.prisma routes the Prisma CLI through `directUrl` because migrate /
 *  db push take a SESSION-level advisory lock (pg_advisory_lock), which a
 *  transaction-mode pooler can't hold — against a pooled host they die with
 *  `P1002 ... Timed out trying to acquire a postgres advisory lock`. Neon's
 *  direct host is the pooled one minus the `-pooler` suffix; anything else (a
 *  plain/local Postgres) is already direct, so the URL copies over unchanged.
 *  Without this, a .env written before `directUrl` was added would instead fail
 *  with "Environment variable not found: DIRECT_URL". */
function ensureDirectUrl(envFile) {
  if (readEnvVar(envFile, "DIRECT_URL")) return;
  const pooled = readEnvVar(envFile, "DATABASE_URL");
  if (!pooled) return;
  const direct = pooled.replace(/-pooler(?=\.)/, "");
  upsertEnvVar(envFile, "DIRECT_URL", direct);
  console.log(
    `\n${cyan("▸ Added DIRECT_URL to server/.env")} — unpooled connection for the Prisma CLI` +
      (direct === pooled ? " (same host; not a pooled URL)." : " (host de-poolered)."),
  );
}

/** Start an ngrok tunnel to :4000 and write its public URL into server/.env as
 *  VAPI_SERVER_URL, so Vapi can reach our local webhook. Best-effort. */
async function startNgrok(envFile) {
  const authtoken = readEnvVar(envFile, "NGROK_AUTHTOKEN") || process.env.NGROK_AUTHTOKEN || "";
  if (!authtoken) {
    console.log(
      yellow(
        "\n⚠ NGROK_AUTHTOKEN not set in server/.env — skipping the tunnel.\n" +
          "  Get a free token at https://dashboard.ngrok.com/get-started/your-authtoken and add it\n" +
          "  (optionally NGROK_DOMAIN=your-reserved-domain for a stable URL).",
      ),
    );
    return;
  }
  try {
    console.log(`\n${cyan("▸ Starting ngrok tunnel → :4000")}`);
    const mod = await import("@ngrok/ngrok");
    const ngrok = mod.default ?? mod;
    const domain = readEnvVar(envFile, "NGROK_DOMAIN") || "";
    const listener = await ngrok.connect({ addr: 4000, authtoken, ...(domain ? { domain } : {}) });
    const url = listener.url();
    upsertEnvVar(envFile, "VAPI_SERVER_URL", url);
    console.log(cyan(`  ngrok: ${url} → :4000  (VAPI_SERVER_URL updated in server/.env)`));
  } catch (e) {
    console.log(
      yellow(`\n⚠ ngrok failed (${String(e?.message ?? e).split("\n")[0]}). Vapi webhooks won't reach localhost.`),
    );
  }
}

try {
  // 1) Dependencies — installs only what's missing/changed; fast when up to date.
  run("Installing frontend dependencies", "npm install", root);
  if (existsSync(join(server, "package.json"))) {
    run("Installing backend dependencies", "npm install", server);
  }

  // 2) Database — apply schema/migrations, only if a DB is configured.
  //    (npm install already (re)generates the Prisma client via postinstall.)
  //    Soft-fail: a transient error or a locked engine (server already running)
  //    must not block the servers from starting.
  const envFile = join(server, ".env");
  const hasDb =
    existsSync(envFile) &&
    /^\s*DATABASE_URL\s*=\s*["']?(postgres|postgresql):\/\//m.test(readFileSync(envFile, "utf8"));

  if (hasDb) {
    // Prisma's CLI steps below go through `directUrl` — make sure it resolves.
    ensureDirectUrl(envFile);

    const migrationsDir = join(server, "prisma", "migrations");
    const hasMigrations =
      existsSync(migrationsDir) && readdirSync(migrationsDir).some((f) => !f.startsWith("."));

    // Bring the schema up to date. Prefer migrations, but the migration history
    // isn't self-contained — it starts mid-stream (no baseline that creates
    // `profiles`/`users`/etc) and assumes a base schema first laid down via
    // `db push`. On a fresh/empty DB `migrate deploy` therefore fails (e.g.
    // ALTER TABLE "profiles" before it exists). When that happens, fall back to
    // `db push`, which syncs every table straight from schema.prisma regardless
    // of migration history, so the DB ends up usable either way.
    let schemaReady = false;
    if (hasMigrations) {
      try {
        run("Applying pending migrations", "npx prisma migrate deploy", server);
        schemaReady = true;
      } catch {
        console.log(
          yellow("\n⚠ migrate deploy failed — falling back to `prisma db push` to sync the schema directly."),
        );
      }
    }
    if (!schemaReady) {
      try {
        run("Syncing database schema (db push)", "npx prisma db push --skip-generate --accept-data-loss", server);
        schemaReady = true;
      } catch (e) {
        const msg = String(e?.message ?? e).split("\n")[0];
        console.log(
          yellow(`\n⚠ Schema sync failed (${msg}).\n  Continuing — the schema may already be in sync.`),
        );
      }
    }

    // (Re)generate the Prisma client to match the just-synced schema. Both schema
    // steps above skip generation (`--skip-generate`; `migrate deploy` never
    // generates), and `npm install` only generates via postinstall when deps
    // actually change — so pulling a schema change with unchanged deps would
    // otherwise leave a STALE client that 500s at runtime (e.g. `prisma.notification`
    // undefined). Soft-fail: a locked engine (a previous server still running)
    // must not block startup — close the old server and rerun to pick it up.
    if (schemaReady) {
      try {
        run("Generating Prisma client", "npx prisma generate", server);
      } catch (e) {
        const msg = String(e?.message ?? e).split("\n")[0];
        console.log(
          yellow(
            `\n⚠ Prisma client generation skipped (${msg}).\n` +
              "  Likely a running server is locking the engine. Fully stop it (Ctrl+C) and rerun `npm run dev`.",
          ),
        );
      }
    }

    // Create the admin (+ demo) only if no admin exists yet. Runs even when a
    // migration step warned above, as long as the schema got synced.
    if (schemaReady) {
      try {
        run("Ensuring an admin account exists", "npm run ensure-admin", server);
      } catch (e) {
        const msg = String(e?.message ?? e).split("\n")[0];
        console.log(yellow(`\n⚠ Admin seed skipped (${msg}).`));
      }
      // Separate from the admin seed above: an existing dev DB already has an
      // admin, so that step short-circuits and would never create the platform
      // SUPER_ADMIN that the Brands and Platform Settings panels require.
      try {
        run("Ensuring the super admin exists", "npm run ensure-super-admin", server);
      } catch (e) {
        const msg = String(e?.message ?? e).split("\n")[0];
        console.log(yellow(`\n⚠ Super-admin seed skipped (${msg}).`));
      }
    }
  } else {
    console.log(
      yellow(
        "\n⚠ No DATABASE_URL in server/.env — skipping DB setup. The backend needs it to start; " +
          "set it, or run `npm run dev:only` for the mock-mode frontend.",
      ),
    );
  }

  // 2.5) ngrok tunnel → server/.env VAPI_SERVER_URL (so Vapi reaches our webhook).
  //      Runs before the servers start so the API picks up the URL on boot.
  await startNgrok(envFile);

  // 3) Start both servers together (Ctrl+C stops both). Free the ports first so a
  //    stale process left by a previous run (common on Windows, where SIGTERM
  //    doesn't reliably reap vite/tsx) doesn't block startup.
  freePorts([4000, 5174]);
  run("Starting backend + frontend (Ctrl+C to stop)", "npm run dev:servers", root);
} catch (err) {
  console.error(red("\n✖ dev startup failed:"), err?.message ?? err);
  process.exit(1);
}
