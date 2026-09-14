import { sendDigests, getLastDigestRun } from "./reports.js";
import { syncVapiWithDb } from "./provisioning.js";
import { replenishPool, releaseNumberPermanently, sweepBrandReclaims } from "./phones.js";
import { integrationsStatus, loadBrandSettings } from "./settings.js";
import { isTwilioConfigured } from "./sms.js";
import { formatDateDMY } from "../lib/date.js";
import { getGraceConfig } from "./billing.js";
import { getEntitlement, daysRemaining } from "./trial.js";
import { decideGraceAction } from "./grace.js";
import { graceStartedEmail, graceWarningEmail, graceEndedEmail } from "./email.js";
import { notify, notifyAdmins } from "./notifications.js";
import { pruneApiRequestLogs, RETENTION_DAYS, installTraceShutdownHook } from "./apiTrace.js";
import { evaluateAlertRules } from "./apiAlerts.js";
import { sweepStalePendingRedemptions } from "./coupons.js";
import { retryPendingVapiSyncs } from "./vapiSync.js";
import { loadBrands } from "./brands.js";
import { sweepPendingDomains } from "./brandDomains.js";
import { archiveCallBlobs, pruneCallLogs } from "./callArchive.js";
import { sweepCallPartitions } from "./callPartitions.js";
import { allCallDbs, allTenants, type TenantClient } from "./tenantDb.js";
import { runWithBrand } from "../lib/brandContext.js";
import { runTenantRetirementSweep } from "./tenantProvisioning.js";
import { rollupBrandStats, catchUpBrandStats, msUntilNextUtc } from "./brandStats.js";
import { env } from "../env.js";
import { scheduleRecurring } from "../lib/jobQueue.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const VAPI_SYNC_MS = 30 * 60 * 1000; // reconcile Vapi orphans every 30 minutes
const VAPI_RESYNC_MS = 5 * 60 * 1000; // retry failed config pushes every 5 minutes
const BRAND_REFRESH_MS = 60 * 1000; // pick up brands created on another instance
const DOMAIN_SWEEP_MS = 5 * 60 * 1000; // re-check brand domains awaiting the client's DNS

let started = false;

async function maybeRunDigests(): Promise<void> {
  try {
    const last = await getLastDigestRun();
    const due = !last || Date.now() - new Date(last).getTime() >= WEEK_MS;
    if (due) {
      const result = await sendDigests();
      console.log(`📬 Weekly digests sent: ${result.sent}, skipped: ${result.skipped}`);
    }
  } catch (e) {
    console.warn("Digest scheduler tick failed:", e instanceof Error ? e.message : e);
  }
}

/** Clean up Vapi assistants/numbers that no longer belong to any DB user (e.g.
 *  a user deleted directly in the DB) — their number returns to the pool. */
async function runVapiSync(): Promise<void> {
  try {
    if (!integrationsStatus().vapi) return;
    const { deletedAssistants, releasedNumbers } = await syncVapiWithDb();
    if (deletedAssistants || releasedNumbers) {
      console.log(
        `🧹 Vapi sync: removed ${deletedAssistants} orphaned assistant(s), released ${releasedNumbers} number(s).`,
      );
    }
  } catch (e) {
    console.warn("Vapi sync tick failed:", e instanceof Error ? e.message : e);
  }
}

/** Re-push saved configs whose last push to Vapi failed, so a live agent that
 *  fell behind during an outage catches up on its own instead of waiting for the
 *  owner to notice and press Save again. */
async function runVapiResync(): Promise<void> {
  try {
    const { recovered, attempted } = await retryPendingVapiSyncs();
    if (recovered) {
      console.log(`🔁 Vapi re-sync: ${recovered}/${attempted} live agent(s) caught up.`);
    }
  } catch (e) {
    console.warn("Vapi re-sync tick failed:", e instanceof Error ? e.message : e);
  }
}

/** Keep the system phone pool topped up to its target (imports owned Twilio
 *  numbers, buys more only if auto-purchase is enabled). Best-effort. */
async function runReplenish(): Promise<void> {
  try {
    if (!isTwilioConfigured()) return;
    const r = await replenishPool();
    if (r.imported || r.purchased) {
      console.log(`📞 Pool replenish: imported ${r.imported}, purchased ${r.purchased} (now ${r.available}/${r.target}).`);
    }
  } catch (e) {
    console.warn("Pool replenish tick failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Post-trial grace sweep. For each lapsed-trial customer whose number is still
 * held: grant the grace window on first sight, send the reminder + final-24h
 * nudges (once each, monotonic via graceNotifyStage), and release the number to
 * the pool once the window lapses. A user who pays mid-grace clears immediately
 * via applyActivePlanMinutes; here we also clear as a backstop. Best-effort.
 */
async function runGraceSweep(): Promise<void> {
  try {
    const cfg = await getGraceConfig();
    if (!cfg.enabled) return;
    const now = new Date();
    // Customers live in their brands' databases: one pass per brand, run as
    // that brand so its emails and notifications carry its name.
    for (const { brandId, db } of await allTenants()) {
      try {
        await runWithBrand(brandId, () => sweepGraceIn(db, cfg, now));
      } catch (e) {
        console.warn(`Grace sweep (brand ${brandId}) failed:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.warn("Grace sweep tick failed:", e instanceof Error ? e.message : e);
  }
}

async function sweepGraceIn(
  db: TenantClient,
  cfg: Awaited<ReturnType<typeof getGraceConfig>>,
  now: Date,
): Promise<void> {
  {
    const candidates = await db.profile.findMany({
      where: {
        graceConsumedAt: null,
        OR: [
          { graceEndsAt: { not: null } },
          { receptionistNumber: { not: "" }, graceStartedAt: null },
        ],
      },
      select: {
        userId: true,
        subscriptionStatus: true,
        currentPeriodEnd: true,
        receptionistNumber: true,
        graceStartedAt: true,
        graceEndsAt: true,
        graceNotifyStage: true,
        user: { select: { email: true, fullName: true } },
      },
    });

    const emailOn = integrationsStatus().email;

    for (const p of candidates) {
      try {
        const ent = await getEntitlement(p.userId, now);
        const email = p.user?.email;
        const fullName = p.user?.fullName || "there";
        const number = p.receptionistNumber || "your number";

        // A paid plan counts as "lapsed" for grace once it can no longer renew and
        // its period is over: either Stripe already canceled it at period end
        // (subscriptionStatus "canceled"), OR it's still "active" with auto-renew
        // OFF and the period end has passed — Stripe WILL cancel it, but that webhook
        // can lag (or never reach a given instance). Auto-renew ON is excluded: that
        // plan renews at period end, so a briefly-past period end is just webhook lag,
        // not a lapse — grabbing its number would be wrong.
        const periodEnded =
          !!p.currentPeriodEnd && now.getTime() >= p.currentPeriodEnd.getTime();
        const planLapsed =
          p.subscriptionStatus === "canceled" ||
          (p.subscriptionStatus === "active" && !ent.autoRenew && periodEnded);

        const action = decideGraceAction({
          enabled: cfg.enabled,
          days: cfg.days,
          blocked: ent.blocked,
          isTrial: ent.isTrial,
          // Lapsed paid plan (canceled, or period-ended with auto-renew off) still
          // holds its number — grace now covers it too, so the number is reserved for
          // the window then released, same as a lapsed trial.
          planLapsed,
          hasNumber: !!p.receptionistNumber,
          graceStartedAt: p.graceStartedAt,
          graceEndsAt: p.graceEndsAt,
          graceNotifyStage: p.graceNotifyStage,
          now,
        });

        switch (action.type) {
          case "noop":
            break;

          case "clear":
            await db.profile.update({
              where: { userId: p.userId },
              data: { graceStartedAt: null, graceEndsAt: null, graceNotifyStage: null },
            });
            break;

          case "start": {
            await db.profile.update({
              where: { userId: p.userId },
              data: { graceStartedAt: now, graceEndsAt: action.graceEndsAt, graceNotifyStage: "granted" },
            });
            if (email && emailOn) {
              await graceStartedEmail({
                ownerEmail: email,
                fullName,
                graceDays: cfg.days,
                graceEndsAt: action.graceEndsAt,
                number,
              });
            }
            void notify(p.userId, {
              type: "billing",
              title: "Your number is reserved during a grace period",
              message: `Pick a plan before ${formatDateDMY(action.graceEndsAt)} to keep your number.`,
              link: "/dashboard/plans",
            });
            break;
          }

          case "reminder":
          case "final": {
            if (email && emailOn) {
              await graceWarningEmail({
                ownerEmail: email,
                fullName,
                daysRemaining: daysRemaining(p.graceEndsAt, now),
                graceEndsAt: p.graceEndsAt!,
                number,
                final: action.type === "final",
              });
            }
            await db.profile.update({
              where: { userId: p.userId },
              data: { graceNotifyStage: action.type },
            });
            break;
          }

          case "release": {
            // Warning window expired on a customer who discontinued: the number
            // goes back to Twilio for good rather than into a pool, so the
            // platform stops paying for inventory nobody is using.
            const freed = await releaseNumberPermanently(p.userId);
            await db.profile.update({
              where: { userId: p.userId },
              // Grace lapsed without renewal → fully suspend: number gone + the
              // dashboard locks behind the reactivation screen until they pick a plan.
              data: { graceConsumedAt: now, graceEndsAt: null, subscriptionStatus: "suspended" },
            });
            if (email && emailOn) {
              await graceEndedEmail({ ownerEmail: email, fullName, number: freed ?? number });
            }
            void notify(p.userId, {
              type: "billing",
              title: "Your reserved number was released",
              message: "Your grace period ended. Pick a plan to get a new number.",
              link: "/dashboard/plans",
            });
            void notifyAdmins({
              type: "system",
              title: "Grace period lapsed — number released",
              message: `${email ?? p.userId} lost their reserved number ${freed ?? number}.`,
            });
            break;
          }
        }
      } catch (e) {
        console.warn("Grace sweep (user) failed:", e instanceof Error ? e.message : e);
      }
    }
  }
}

/**
 * Release coupon reservations left behind by abandoned checkouts, so a capped
 * campaign isn't held hostage by shoppers who never paid. The rows are DELETED
 * rather than marked — a leftover row would trip the unique (couponId, userId)
 * index and permanently lock the user out of a code they never actually used.
 */
async function runCouponSweep(): Promise<void> {
  try {
    const released = await sweepStalePendingRedemptions();
    if (released > 0) console.log(`🎟️  Coupon sweep: released ${released} stale reservation(s)`);
  } catch (e) {
    console.warn("Coupon sweep tick failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Move brand-pooled numbers past their reclaim window into the shared platform
 * pool, so inventory a brand isn't using becomes available to every brand.
 *
 * Hourly rather than daily: the window is configurable down to 0 days, and a
 * number that should already be back in circulation sitting idle for most of a
 * day is inventory the platform pays for and nobody can use.
 */
async function runReclaimSweep(): Promise<void> {
  try {
    const moved = await sweepBrandReclaims();
    if (moved > 0) {
      console.log(`📵 Brand reclaim sweep: moved ${moved} number(s) to the shared pool`);
    }
  } catch (e) {
    console.warn("Brand reclaim sweep tick failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Promote brand vanity domains whose client has published the DNS since the
 * last look, so the operator never has to come back and press "Check now".
 * Cheap when nothing is pending: one indexed read and no lookups at all.
 */
async function runDomainSweep(): Promise<void> {
  try {
    const { checked, verified } = await sweepPendingDomains();
    if (verified > 0) {
      console.log(`🌐 Brand domain sweep: ${verified}/${checked} pending domain(s) now verified`);
    }
  } catch (e) {
    console.warn("Brand domain sweep tick failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Start background schedulers. Idempotent.
 *  - Vapi reconcile: opt-in via ENABLE_VAPI_RECONCILE=true — clears orphaned
 *    assistants/numbers periodically (first pass shortly after boot, then every
 *    30 min). Destructive, so off by default and meant for one owning instance.
 *  - Vapi config re-sync: always on — retries config pushes that failed (every
 *    5 min), so a live agent left stale by an outage repairs itself.
 *  - Pool replenish: always on — keeps the system pool at its target size.
 *  - Grace sweep + coupon sweep: always on, hourly.
 *  - Brand domain sweep: always on, every 5 min — promotes a brand's vanity
 *    domain to "verified" once the client's DNS records have landed.
 *  - Weekly digests: opt-in via ENABLE_DIGESTS=true so dev never surprise-emails.
 */
export function startScheduler(): void {
  if (started) return;
  started = true;

  // Reconcile is destructive (it deletes Vapi assistants/numbers absent from THIS
  // DB), so it must run on exactly one instance that owns the Vapi account. Any
  // other instance sharing the Vapi key (dev box, staging) would wipe the account.
  // Opt-in via ENABLE_VAPI_RECONCILE=true so it never runs by surprise.
  if (process.env.ENABLE_VAPI_RECONCILE === "true") {
    setTimeout(() => void runVapiSync(), 30_000);
    setInterval(() => void runVapiSync(), VAPI_SYNC_MS);
    console.log("🧹 Vapi reconcile scheduler started (every 30 min)");
  } else {
    console.log("🧹 Vapi reconcile scheduler disabled (set ENABLE_VAPI_RECONCILE=true to enable)");
  }

  // Unlike reconcile above, this one is always on: it only re-pushes configs this
  // DB already owns to assistants that already exist, so it deletes nothing and a
  // second instance running it at the same time just repeats an idempotent PATCH.
  setTimeout(() => void runVapiResync(), 100_000);
  setInterval(() => void runVapiResync(), VAPI_RESYNC_MS);
  console.log("🔁 Vapi config re-sync scheduler started (every 5 min)");

  setTimeout(() => void runReplenish(), 45_000);
  setInterval(() => void runReplenish(), VAPI_SYNC_MS);
  console.log("📞 Pool replenish scheduler started (every 30 min)");

  setTimeout(() => void runGraceSweep(), 60_000);
  setInterval(() => void runGraceSweep(), HOUR_MS);
  console.log("🛟 Grace-period sweep scheduler started (hourly)");

  setTimeout(() => void runCouponSweep(), 75_000);
  setInterval(() => void runCouponSweep(), HOUR_MS);
  console.log("🎟️  Coupon reservation sweep scheduler started (hourly)");

  setTimeout(() => void runReclaimSweep(), 90_000);
  setInterval(() => void runReclaimSweep(), HOUR_MS);
  console.log("📵 Brand reclaim sweep scheduler started (hourly)");

  // Safe on every instance: it only ever promotes a pending claim whose DNS
  // now checks out, and two instances checking the same domain reach the same
  // answer. Verified domains are left alone (see sweepPendingDomains).
  setTimeout(() => void runDomainSweep(), 120_000);
  setInterval(() => void runDomainSweep(), DOMAIN_SWEEP_MS);
  console.log("🌐 Brand domain sweep scheduler started (every 5 min)");

  // Brand + brand-setting caches. Both refresh in-process the moment they're
  // written, so this is purely for the multi-instance case: a brand created on
  // instance A is invisible to instance B — its subdomain would 404 as "not a
  // brand" — until B reloads. Cheap (two small table reads), so a short period.
  setInterval(() => {
    void loadBrands();
    void loadBrandSettings();
  }, BRAND_REFRESH_MS);
  console.log("🏷️  Brand cache refresh started (every minute)");

  if (process.env.ENABLE_DIGESTS === "true") {
    void maybeRunDigests();
    setInterval(() => void maybeRunDigests(), HOUR_MS);
    console.log("⏰ Weekly digest scheduler started (ENABLE_DIGESTS=true)");
  }

  // API Center. Alerts are evaluated every five minutes so a provider that goes
  // down out of hours is already flagged when someone looks; the log sweep runs
  // daily because api_request_logs takes a write on every outbound call and would
  // otherwise grow without limit.
  installTraceShutdownHook();

  // These two are the job-queue pilot (see lib/jobQueue.ts): each is
  // independently switchable onto pg-boss via its own env flag, with the
  // original setInterval kept as the instant, redeploy-free rollback path
  // until the queue path is proven stable.
  if (env.JOBS_VIA_QUEUE_ALERT_RULES === "true") {
    void scheduleRecurring("alert-rules", "*/5 * * * *", async () => {
      await evaluateAlertRules();
    }).catch((e) => console.error("[scheduler] failed to schedule alert-rules via queue:", e));
    console.log("🔌 API Center alerts scheduled via job queue (every 5 min)");
  } else {
    setTimeout(() => void evaluateAlertRules(), 90_000);
    setInterval(() => void evaluateAlertRules(), 5 * 60 * 1000);
    console.log("🔌 API Center alerts scheduler started (every 5 min)");
  }

  if (env.JOBS_VIA_QUEUE_API_LOG_SWEEP === "true") {
    void scheduleRecurring("api-log-sweep", "0 0 * * *", runApiLogSweep).catch((e) =>
      console.error("[scheduler] failed to schedule api-log-sweep via queue:", e),
    );
    console.log("🔌 API Center log sweep scheduled via job queue (daily)");
  } else {
    setTimeout(() => void runApiLogSweep(), 5 * 60 * 1000);
    setInterval(() => void runApiLogSweep(), DAY_MS);
    console.log("🔌 API Center log sweep scheduler started (daily)");
  }

  // Call log tiering. Daily, and offset ten minutes past boot so a deploy never
  // has a restart storm racing S3 while the app is still warming up.
  //
  // Unconditional, unlike the other optional schedulers: partition provisioning
  // has to run even with archiving and retention both switched off, or the
  // calendar eventually outruns the months that exist and every new call drops
  // into call_logs_default. The sweep itself no-ops on a deployment that hasn't
  // been partitioned yet.
  setTimeout(() => void runCallArchiveSweep(), 10 * 60 * 1000);
  setInterval(() => void runCallArchiveSweep(), DAY_MS);
  console.log(
    `🗄️  Call log scheduler started (partitions daily` +
      `, blobs → S3 after ${env.CALL_ARCHIVE_AFTER_DAYS || "never"}${env.CALL_ARCHIVE_AFTER_DAYS ? "d" : ""}` +
      `, delete after ${env.CALL_RETENTION_DAYS || "never"}${env.CALL_RETENTION_DAYS ? "d" : ""})`,
  );

  // A deleted brand's database is kept 30 days, then removed. Daily, offset so
  // it never coincides with the call sweep above.
  setTimeout(() => void runTenantRetirementSweep().catch(logSweepError("tenant retirement")), 20 * 60 * 1000);
  setInterval(() => void runTenantRetirementSweep().catch(logSweepError("tenant retirement")), DAY_MS);

  // Brand stats rollup (plan §7): visit every tenant once a night and write
  // the day just ended into Main, so the super admin's overview never has to.
  // Fixed at 00:15 UTC rather than "daily from boot" because the row is about
  // a calendar day. At boot, a night the process slept through is made up.
  setTimeout(() => void catchUpBrandStats().catch(logSweepError("brand stats catch-up")), 3 * 60 * 1000);
  setTimeout(() => {
    void rollupBrandStats().catch(logSweepError("brand stats"));
    setInterval(() => void rollupBrandStats().catch(logSweepError("brand stats")), DAY_MS);
  }, msUntilNextUtc(0, 15));
  console.log("📊 Brand stats rollup scheduled (nightly at 00:15 UTC)");
}

function logSweepError(what: string) {
  return (err: unknown) => console.error(`[scheduler] ${what} sweep failed:`, err);
}

/**
 * Maintain every brand's call table: partitions, then the S3 archive, then the
 * retention window — in that order, once per tenant.
 *
 * Archive before prune: a row about to be deleted shouldn't have just been
 * uploaded, and the other way round would pay for a PUT whose object the same
 * sweep immediately deletes. Calls live in each brand's own database, so the
 * whole sweep runs per active tenant, and one unreachable database must not
 * stop the others — a single failing project would otherwise stall maintenance
 * for the whole platform. The control plane has no call table (phase 6).
 */
async function runCallArchiveSweep(): Promise<void> {
  let tenants: Awaited<ReturnType<typeof allCallDbs>>;
  try {
    tenants = await allCallDbs();
  } catch (e) {
    console.warn("Call sweep could not list the brand databases:", e instanceof Error ? e.message : e);
    return;
  }

  for (const { brandId, db } of tenants) {
    try {
      const parts = await sweepCallPartitions(env.CALL_RETENTION_DAYS, new Date(), db, "call_logs");
      if (parts.created.length || parts.dropped.length) {
        console.log(
          `📅 Brand ${brandId} call partitions: created ${parts.created.join(", ") || "none"}` +
            `, dropped ${parts.dropped.join(", ") || "none"}`,
        );
      }
      if (parts.defaultRows > 0) {
        // Not fatal — the calls are safely stored and readable. But they are in
        // a partition nothing will ever drop, so say so loudly rather than let
        // the table quietly go back to growing without bound.
        console.warn(
          `⚠️  ${parts.defaultRows} call(s) for brand ${brandId} landed in call_logs_default — ` +
            `a partition sweep was missed.`,
        );
      }

      const { archived, failed, more } = await archiveCallBlobs(db);
      if (archived || failed) {
        console.log(
          `🗄️  Brand ${brandId} call archive: ${archived} transcript(s) moved to S3` +
            (failed ? `, ${failed} failed (retried next sweep)` : "") +
            (more ? " — more remain, continuing tomorrow" : ""),
        );
      }
      const pruned = await pruneCallLogs(db);
      if (pruned > 0) {
        console.log(
          `🧽 Brand ${brandId}: pruned ${pruned} call log(s) older than ${env.CALL_RETENTION_DAYS} days`,
        );
      }
    } catch (e) {
      console.warn(`Call sweep failed for brand ${brandId}:`, e instanceof Error ? e.message : e);
    }
  }
}

/** Drop API request rows past the retention window. */
async function runApiLogSweep(): Promise<void> {
  try {
    const deleted = await pruneApiRequestLogs();
    if (deleted > 0) console.log(`🧽 Pruned ${deleted} API request logs older than ${RETENTION_DAYS} days`);
  } catch (e) {
    console.warn("API log sweep failed:", e instanceof Error ? e.message : e);
  }
}
