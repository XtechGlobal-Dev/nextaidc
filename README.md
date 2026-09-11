# hello22.ai — Voice Receptionist .. 

A **Vite + React 19 + TypeScript + Tailwind v4** single-page app for the
hello22.ai "24/7 AI voice receptionist" dashboard, backed by the Express + Prisma +
Postgres API in [`server/`](server/). Zustand stores hydrate from the backend (and cache
to `localStorage` between loads).
//test
> Voice/telephony targets **Vapi**; the agent voice is **Deepgram Aura-2** (played by
> Vapi's "deepgram" provider, and via /api/tts for in-app previews). "Book a Meeting"
> is a plain placeholder (no Cal.com).

## Quick start

```bash
npm run dev
```
 
That single command (root) does everything:
1. installs/refreshes deps in **both** the frontend and `server/`
2. if `server/.env` has a Postgres `DATABASE_URL`, applies the DB schema
   (`prisma migrate deploy` if migrations exist, else `prisma db push`)
3. starts the **backend** (http://localhost:4000) and **frontend**
   (http://localhost:5174) together — Ctrl+C stops both

Other scripts:
- `npm run dev:only` — frontend only (expects the backend already running)
- `npm run dev:servers` — start both servers without the install/DB step
- `npm run build`, `npm run preview`, `npm run typecheck`

## Backend required

The app always talks to the backend API. `VITE_API_URL` points the frontend at it
(defaults to `http://localhost:4000` when unset — see `.env`). Start the API from
[`server/`](server/) — see [`GO_LIVE.md`](GO_LIVE.md) for DB + integration setup. Without
a reachable backend the app shows the real `/login` screen but can't authenticate.

## Routes

| Path | Page |
|------|------|
| `/dashboard` | Voice Agent Analytics (metric cards, inline-SVG charts) |
| `/dashboard/calls` | Call Logs (table, filters, detail panel, transcript/analysis) |
| `/dashboard/assistant` | **AI Brain** — the core feature |
| `/dashboard/crm` | CRM Lead Delivery (Google Calendar, custom webhook) |
| `/dashboard/settings` | Account Settings (profile, usage, subscription, support) |
| `/dashboard/admin/brands` | **Brands** — white-label tenants (super admin only) |
| `*` | 404 |

## The AI Brain (core)

The defensible part of the product: a friendly, section-based editor that **compiles a
structured `agent_config` into a clean LLM system prompt + voice params**, then hands that
to a live Vapi voice agent.

- Config model: [`src/types/agent.ts`](src/types/agent.ts)
- Compiler (structured config → labelled master prompt): [`src/lib/compilePrompt.ts`](src/lib/compilePrompt.ts)
- Vapi assistant payload builder: [`src/lib/vapi.ts`](src/lib/vapi.ts)
- Sections (Identity / Knowledge / Rules / Automations / Advanced):
  [`src/pages/assistant/`](src/pages/assistant/)

Edits auto-save (debounced) and recompile the master prompt live, unless you hand-edit the
prompt in **Advanced** (which pauses auto-sync until you hit *Regenerate*). Premium-gated
features (extra voices, human handover, automations) are marked with an amber **PLAN** badge.

## Structure

```
src/
  components/ui/        shadcn-style Radix primitives (button, card, dialog, …)
  components/layout/    Sidebar, AppLayout, PageHeader
  components/chat/      support chat widget
  components/assistant/ in-browser call tester (Vapi, mock-first)
  data/                 voices, mock calls/profile, default agent config
  lib/                  utils, env, compilePrompt, vapi client
  pages/                one folder per route
  stores/               Zustand stores (agent, calls, profile, crm, chat, ui)
  types/                agent_config + call + account types
```

## Multi-tenant white-label brands

One deployment serves many **brands**. A brand is a second front door: its own
subdomain, logo, palette, font and — optionally — its own mail, SMS and WhatsApp
senders, run day to day by its own admin. Its customers never see the platform's name.

**Roles.** `SUPER_ADMIN` (the platform owner) > `ADMIN` (runs ONE brand) > `STAFF`
(permission matrix). Use the helpers in [`src/lib/roles.ts`](src/lib/roles.ts) and
[`server/src/lib/roles.ts`](server/src/lib/roles.ts) — never compare to `"ADMIN"` by hand,
or the super admin silently loses the ordinary admin screens.

**Super admin only** — a brand admin gets a 403, not a narrower view:
Brands, Platform Settings (every integration credential) and the API Center. That is the
point of the split: provider keys are the platform's, billed to the platform, and shared
by every tenant.

Seeded credentials (override with `SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD`):

```
superadmin@ai.com / Super@001
```

`npm run dev` creates it automatically. On an existing database run
`npm --prefix server run ensure-super-admin` — it touches exactly one row (and re-running
it resets the password, which is the way back in if it's lost).

**How a brand is addressed.** Its own subdomain — `acme.hello22.ai` — from the
moment it's created, and its own domain once that is verified (see *Addresses*
below). On either, the host names the brand and the app lives at the plain path.
The path-routed form `app.example.com/acme` works too and needs no DNS at all:
the SPA resolves that segment once at boot and uses it as the router's
`basename`, so every `Link`, redirect and `navigate()` keeps the prefix without
knowing it exists ([`src/lib/brandRoute.ts`](src/lib/brandRoute.ts)). Since every
brand shares one host there, the client names its brand to the API with an
`X-Brand` header. That header selects a **public front door** and grants nothing:
the moment a request is authenticated, `requireAuth` re-scopes it to the tenant
the account actually belongs to.

**Where the panels live.** The platform owner works at `/superadmin/*`, brand
admins at `/dashboard/admin/*`. Both are the same route tree mounted twice
(`adminRoutes` in [`src/App.tsx`](src/App.tsx)), so a page added for one is
automatically there for the other. `/superadmin` is a reserved segment, so no
brand can ever claim it.

**Membership is a row, not a column.** `brand_members` is the junction and the
source of truth (`userId` is UNIQUE — a person belongs to at most one brand).
`users.brandId`, `profiles.brandId` and `call_logs.brandId` are denormalised
mirrors of it, so the tenant filter on every admin query is an indexed column
read rather than a join — the same trade-off `users.permissions` already makes
against `staff_roles`. Never write them directly: `setBrandMembership()` writes
the junction and every mirror in one transaction, and `resyncBrandMirrors()` is
the repair tool if they're ever suspected of drifting.

**Creating a brand** — Admin → Brands → New Brand, in one form:
1. Name + address slug (checked live against a reserved list and existing brands),
   optional custom domain, tagline and support contacts, the customers' default country
   and timezone, and whether the door is open to public sign-up or invite-only.
2. Its administrator — created in the same call and emailed their credentials, so a brand
   is never left standing with no way in.
3. Theme — ten colour presets (or hand-picked hex), and a typeface from the **Business**
   (sans) or **Classic** (serif) family, previewed live.

Then, on the saved brand — with a **Setup** checklist at the top naming what is still
missing and the tab that fixes it:
- **Access & plans** — which modules its customers get (Booking, Call Transfer, CRM, SMS to
  Caller, WhatsApp; a switched-off module leaves the nav and its API answers 403), which
  plans it sells (blank = every active plan), trial overrides (days, minutes, card at
  sign-up), and the voice new agents start on. See
  [`server/src/services/brandSetup.ts`](server/src/services/brandSetup.ts).
- **Content** — sign-in screen copy, website and help links, the legal entity, address and
  policy links every email footer is signed with, and per-brand analytics scripts (which
  replace the platform's on that brand's pages).
- **Pricing & wallet** — the platform sets each plan's base price; the brand adds its own
  **addon** on top (its admin may do this from Admin → Pricing when allowed, within any cap).
  Customers pay base + addon to the platform's Stripe, through a Stripe Price of the brand's
  own; on every paid invoice the addon share (proportional if discounted) is credited to the
  brand's **wallet**. The platform owner pays the brand by hand and records the payout here;
  brand admins see their balance and history under Admin → Wallet, and both sides can export
  the ledger as CSV. A refund reverses the credit in proportion (from Stripe's cumulative
  `charge.refunded`, so replays never double-book). Existing subscribers keep the Price they
  signed up with until the platform owner presses **Apply to N subscribers**, which moves them
  from their next cycle with no proration; when the platform changes a plan's base price, every
  brand Price on it is rebuilt and the brand's admins are notified. See
  [`server/src/services/brandPricing.ts`](server/src/services/brandPricing.ts) and
  [`server/src/services/brandWallet.ts`](server/src/services/brandWallet.ts).
- **White-label** — logos + favicon, and its own mail / SMS / WhatsApp senders.

**How a request finds its tenant.** [`middleware/brand.ts`](server/src/middleware/brand.ts)
resolves the brand from the request Host, then the browser `Origin`/`Referer` (the API
rarely shares a hostname with the app), and puts it in async-local storage for the whole
request. Once authenticated, the user's OWN brand wins. Off-request work (schedulers,
webhooks) has no ambient brand and falls back to the platform, exactly as before brands
existed. CORS accepts any host that resolves to an active brand, so a new subdomain works
without a redeploy.

**Addresses.** A `*.<PLATFORM_DOMAIN>` wildcard record plus its wildcard certificate cover
every brand, so `acme.hello22.ai` serves the moment the brand exists — no per-brand DNS,
no certificate to wait on. A brand's OWN domain (`app.acmevoice.com`) is claimed from the
Domain tab, which registers the hostname with Vercel and hands the operator the two records
the client publishes. Only a **verified** domain is used to build that brand's links.
A brand's domain serves the **SPA only**: the API, every provider webhook, the Google
OAuth callback and the public `/c/*` call pages stay on the platform's own API host for
every brand, so creating a brand provisions nothing API-side. Pending domains are
re-checked every five minutes and go live on their own once the client's DNS lands.
Full setup and the per-integration breakdown: [`docs/white-label-domains.md`](docs/white-label-domains.md).

**Settings resolution** is a three-step fallback everywhere:
`brand override → platform DB setting → env var`. A brand only stores what it actually
white-labels; blank means "use the platform's".

**Data isolation.** `users.brandId` is the tenant key, and every account has one except
the platform's own people — the super admin and the support staff they employ. The
database enforces it (`0057_every_account_has_a_brand`). `tenantScope(req.user)` narrows
the admin queries (customers, subscriptions, staff, resellers, impersonation) to the
caller's brand; only platform accounts get the platform-wide view. New sign-ups inherit
the brand their request resolved to, and the platform's own door takes no sign-ups at
all — a customer is always some brand's.

**Locally**, open `acme.localhost:5174` to use the brand's own front door exactly as its
customers will — outside production `localhost` counts as a platform apex, and browsers
resolve `*.localhost` to loopback on their own, so there is nothing to configure.
`localhost:5174/acme` works too (path routing needs no DNS at all). Getting this right
matters: a brand opened on a host the API doesn't recognise is painted as the platform,
and anyone signing up there is created as a **platform** customer rather than the brand's.
To test a brand's vanity domain locally, point it at 127.0.0.1 in your hosts file and set
`ALLOW_UNVERIFIED_BRAND_DOMAINS=true` (a dev machine can't publish the real TXT proof).
A request may also name a brand by raw id with the `x-brand-id` header, which skips the
public lookup and so is never honoured in production.

## Design tokens

Light theme, DM Sans, brand blue `#2C76ED`. All tokens live in
[`src/index.css`](src/index.css) under Tailwind v4 `@theme` and are used via semantic
classes (`bg-primary`, `text-success`, `bg-warm`, `bg-premium-tint`, …).

A brand re-themes the app by overriding those same custom properties inline on `<html>`
(see [`src/lib/brandTheme.ts`](src/lib/brandTheme.ts)) — one write repaints every button,
badge, chart and nav item, with the soft tints derived from the brand hue rather than
configured separately.

## Notes / deviations

- Uses **zod 3** (not 4) for ecosystem/`@hookform/resolvers` compatibility. Bump later if needed.
- The Express + Prisma backend lives in [`server/`](server/); the frontend stores call it
  directly via [`src/lib/api.ts`](src/lib/api.ts).
