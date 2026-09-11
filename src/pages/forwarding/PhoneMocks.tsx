import type { ReactNode } from "react";
import {
  Bluetooth,
  Check,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Phone,
  PhoneCall,
  Plane,
  Search,
  Wifi,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 *  Realistic phone "screenshots" for the call-forwarding guide. These
 *  are CSS mockups (not real screenshots) that imitate the actual iOS
 *  Settings / Android UI for each step, inside a device frame with a
 *  status bar, notch and home indicator. The screens render in a fixed
 *  light appearance (like a real phone showing its own UI), independent
 *  of the app's theme. A looping "demo" animation taps through each step.
 * ------------------------------------------------------------------ */

/* --------------------------------- chrome -------------------------------- */

/** Signal + Wi-Fi + battery cluster for the status bar. */
function StatusIcons() {
  return (
    <span className="flex items-center gap-[2px] text-black">
      {/* Cellular signal — four rounded bars */}
      <svg viewBox="0 0 16 10" className="h-[6px] w-[9px]" fill="currentColor" aria-hidden>
        <rect x="0" y="7" width="2.6" height="3" rx="0.8" />
        <rect x="4.4" y="4.7" width="2.6" height="5.3" rx="0.8" />
        <rect x="8.8" y="2.4" width="2.6" height="7.6" rx="0.8" />
        <rect x="13.2" y="0" width="2.6" height="10" rx="0.8" />
      </svg>
      {/* Wi-Fi — filled fan */}
      <svg viewBox="0 0 24 18" className="h-[6px] w-[8px]" fill="currentColor" aria-hidden>
        <path d="M12 17.2l3.4-4.2c-1.9-1.6-4.9-1.6-6.8 0L12 17.2z" />
        <path d="M5.6 9.9l1.8 2.2c2.6-2.1 6.6-2.1 9.2 0l1.8-2.2c-3.6-3-10.2-3-12.8 0z" />
        <path d="M12 2.4C8.3 2.4 4.7 3.7 2 6.2l1.8 2.2c4.3-3.8 12.1-3.8 16.4 0L22 6.2C19.3 3.7 15.7 2.4 12 2.4z" />
      </svg>
      {/* Battery — outline + fill + nub */}
      <svg viewBox="0 0 26 12" className="h-[7px] w-[12px]" aria-hidden>
        <rect x="0.6" y="0.6" width="21.4" height="10.8" rx="3" fill="none" stroke="currentColor" strokeOpacity="0.4" />
        <rect x="2.2" y="2.2" width="16.6" height="7.6" rx="1.4" fill="currentColor" />
        <rect x="23" y="4" width="1.8" height="4" rx="0.9" fill="currentColor" fillOpacity="0.4" />
      </svg>
    </span>
  );
}

function Frame({
  children,
  variant = "ios",
}: {
  children: ReactNode;
  variant?: "ios" | "android";
}) {
  return (
    <div className="relative mx-auto w-[124px] [zoom:1.5]">
      {/* Side buttons (volume + power) for a real-device look */}
      <span className="absolute -left-[2px] top-[19%] h-3.5 w-[2px] rounded-l bg-neutral-700" />
      <span className="absolute -left-[2px] top-[33%] h-6 w-[2px] rounded-l bg-neutral-700" />
      <span className="absolute -left-[2px] top-[49%] h-6 w-[2px] rounded-l bg-neutral-700" />
      <span className="absolute -right-[2px] top-[35%] h-8 w-[2px] rounded-r bg-neutral-700" />

      {/* Metal frame */}
      <div className="rounded-[1.35rem] bg-gradient-to-b from-neutral-700 via-neutral-800 to-neutral-950 p-[3px] shadow-[0_12px_28px_-10px_rgba(0,0,0,0.5)] ring-1 ring-black/10 dark:ring-white/10">
        <div className="relative flex aspect-[9/19] flex-col overflow-hidden rounded-[1.1rem] bg-white">
          {/* Notch — iOS dynamic island / Android punch-hole camera */}
          {variant === "ios" ? (
            <div className="absolute left-1/2 top-1 z-30 h-[11px] w-7 -translate-x-1/2 rounded-full bg-black" />
          ) : (
            <div className="absolute left-1/2 top-[3px] z-30 size-1.5 -translate-x-1/2 rounded-full bg-black shadow-[0_0_0_1.5px_rgba(0,0,0,0.15)]" />
          )}

          {/* Status bar */}
          <div className="flex shrink-0 items-center justify-between px-1.5 pt-[3px] text-[6px] font-semibold text-black">
            <span className="tabular-nums">9:41</span>
            <StatusIcons />
          </div>

          {/* Screen body — each screen fills this with its own background */}
          <div className="relative flex-1 overflow-hidden">{children}</div>

          {/* Home indicator */}
          <div className="flex shrink-0 justify-center py-[3px]">
            <span
              className={cn(
                "h-[3px] rounded-full bg-black/75",
                variant === "ios" ? "w-1/3" : "w-1/4",
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Looping fingertip that lands on the control a step asks the user to tap. */
function TapDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mock-tap pointer-events-none absolute z-20 size-3 rounded-full bg-black/25 ring-1 ring-black/40",
        className,
      )}
    />
  );
}

/** A trimmed AI number so it fits the tiny mock screen. */
function shortNumber(n: string): string {
  const v = n.trim();
  if (!v) return "AI no.";
  const digits = v.replace(/[^\d]/g, "");
  return digits.length > 5 ? `…${digits.slice(-5)}` : v;
}

/* ----------------------------- iOS primitives ---------------------------- */

function IosScreen({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col gap-1.5 bg-[#f2f2f7] px-1.5 pb-1 pt-1.5">{children}</div>;
}

function IosNav({ title }: { title: string }) {
  return (
    <div className="relative -mx-1.5 -mt-1.5 flex items-center justify-center bg-[#f9f9f9]/90 px-1.5 py-1">
      <ChevronLeft className="absolute left-1 size-3 text-[#007aff]" strokeWidth={3} />
      <span className="max-w-[80%] truncate text-[8.5px] font-semibold text-[#1c1c1e]">{title}</span>
    </div>
  );
}

function IosGroup({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-black/[0.07] overflow-hidden rounded-[8px] bg-white">
      {children}
    </div>
  );
}

function IosToggle({ on, animated }: { on?: boolean; animated?: boolean }) {
  if (animated) {
    return (
      <span className="mock-toggle-track relative h-2.5 w-4 shrink-0 rounded-full bg-[#e9e9ea]">
        <span className="mock-toggle-knob absolute left-px top-px size-2 rounded-full bg-white shadow-sm" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex h-2.5 w-4 shrink-0 items-center rounded-full p-px",
        on ? "justify-end bg-[#34c759]" : "justify-start bg-[#e9e9ea]",
      )}
    >
      <span className="size-2 rounded-full bg-white shadow-sm" />
    </span>
  );
}

function IosRow({
  icon: Icon,
  iconBg,
  label,
  value,
  chevron,
  toggle,
  animatedToggle,
  typing,
  active,
  tap,
}: {
  icon?: typeof Plane;
  iconBg?: string;
  label: string;
  value?: string;
  chevron?: boolean;
  toggle?: boolean;
  animatedToggle?: boolean;
  typing?: boolean;
  active?: boolean;
  tap?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex items-center gap-1.5 px-1.5 py-1",
        active && "bg-black/[0.05]",
        tap && "mock-press",
      )}
    >
      {tap && <TapDot className="right-2.5 top-1/2 -translate-y-1/2" />}
      {Icon && (
        <span
          style={{ background: iconBg }}
          className="flex size-3.5 shrink-0 items-center justify-center rounded-[4px]"
        >
          <Icon className="size-2 text-white" strokeWidth={2.5} />
        </span>
      )}
      <span className="flex-1 truncate text-[8px] font-medium text-[#1c1c1e]">{label}</span>
      {animatedToggle ? (
        <IosToggle animated />
      ) : toggle !== undefined ? (
        <IosToggle on={toggle} />
      ) : value ? (
        <span className={cn("shrink-0 font-medium text-[7.5px] text-[#8e8e93]", typing && "mock-type")}>
          {value}
        </span>
      ) : null}
      {chevron && <ChevronRight className="size-2 shrink-0 text-black/25" strokeWidth={3} />}
    </div>
  );
}

/* -------------------------------- iOS screens ---------------------------- */

export function IosSettings() {
  return (
    <Frame>
      <IosScreen>
        <p className="px-0.5 text-[13px] font-bold leading-none text-[#1c1c1e]">Settings</p>
        <div className="flex items-center gap-1 rounded-[7px] bg-black/[0.06] px-1.5 py-[3px] text-[7.5px] text-[#8e8e93]">
          <Search className="size-2" strokeWidth={2.5} />
          Search
        </div>
        <IosGroup>
          <IosRow icon={Plane} iconBg="#ff9500" label="Airplane Mode" toggle={false} />
          <IosRow icon={Wifi} iconBg="#007aff" label="Wi-Fi" value="Home" chevron />
          <IosRow icon={Bluetooth} iconBg="#007aff" label="Bluetooth" value="On" chevron />
        </IosGroup>
        <IosGroup>
          <IosRow icon={Phone} iconBg="#34c759" label="Phone" chevron active tap />
        </IosGroup>
      </IosScreen>
    </Frame>
  );
}

export function IosPhoneMenu() {
  return (
    <Frame>
      <IosScreen>
        <IosNav title="Phone" />
        <IosGroup>
          <IosRow label="My Number" value="+1 (555)…" />
        </IosGroup>
        <IosGroup>
          <IosRow label="Call Forwarding" chevron active tap />
          <IosRow label="Call Waiting" chevron />
          <IosRow label="Show My Caller ID" chevron />
        </IosGroup>
      </IosScreen>
    </Frame>
  );
}

export function IosForwarding({ number }: { number: string }) {
  return (
    <Frame>
      <IosScreen>
        <IosNav title="Call Forwarding" />
        <IosGroup>
          <IosRow label="Call Forwarding" animatedToggle tap />
          <IosRow label="Forward To" value={shortNumber(number)} typing chevron />
        </IosGroup>
      </IosScreen>
    </Frame>
  );
}

/* --------------------------- Android primitives -------------------------- */

function AndroidScreen({ children }: { children: ReactNode }) {
  return <div className="relative flex h-full flex-col bg-white">{children}</div>;
}

function AndroidToolbar({
  title,
  back,
  menu,
  tapMenu,
}: {
  title: string;
  back?: boolean;
  menu?: boolean;
  tapMenu?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 px-1.5 py-1.5">
      {back && <ChevronLeft className="size-3 shrink-0 text-[#202124]" strokeWidth={2.5} />}
      <span className="flex-1 truncate text-[9.5px] font-medium text-[#202124]">{title}</span>
      {menu && (
        <span className="relative">
          {tapMenu && <TapDot className="-left-1 top-1/2 -translate-y-1/2" />}
          <MoreVertical className="size-3 text-[#202124]" />
        </span>
      )}
    </div>
  );
}

function AndroidRow({
  label,
  sub,
  active,
  tap,
}: {
  label: string;
  sub?: string;
  active?: boolean;
  tap?: boolean;
}) {
  return (
    <div className={cn("relative px-2 py-1.5", active && "bg-[#e8f0fe]", tap && "mock-press")}>
      {tap && <TapDot className="right-2 top-1/2 -translate-y-1/2" />}
      <p className={cn("text-[9px] font-medium", active ? "text-[#1a73e8]" : "text-[#202124]")}>{label}</p>
      {sub && <p className="text-[7px] text-[#5f6368]">{sub}</p>}
    </div>
  );
}

/* -------------------------------- Android screens ------------------------ */

export function AndroidDialer() {
  return (
    <Frame variant="android">
      <AndroidScreen>
        <AndroidToolbar title="Phone" menu tapMenu />
        <div className="mx-2 flex items-center gap-1 rounded-full bg-[#f1f3f4] px-2 py-1 text-[8px] text-[#5f6368]">
          <Search className="size-2.5" strokeWidth={2.5} />
          Search
        </div>
        {/* ⋮ overflow menu that pops open after the tap */}
        <div className="mock-menu absolute right-1 top-6 z-20 w-[64%] overflow-hidden rounded-[6px] bg-white py-0.5 shadow-lg ring-1 ring-black/10">
          <p className="relative bg-[#e8f0fe] px-2 py-1 text-[8px] font-medium text-[#1a73e8]">Settings</p>
          <p className="px-2 py-1 text-[8px] text-[#202124]">Call history</p>
          <p className="px-2 py-1 text-[8px] text-[#202124]">Help &amp; feedback</p>
        </div>
      </AndroidScreen>
    </Frame>
  );
}

export function AndroidCallSettings() {
  return (
    <Frame variant="android">
      <AndroidScreen>
        <AndroidToolbar back title="Call settings" />
        <AndroidRow label="Calling accounts" sub="SIM, Wi-Fi calling" />
        <AndroidRow label="Call forwarding" sub="Divert incoming calls" active tap />
        <AndroidRow label="Voicemail" sub="Notifications, number" />
      </AndroidScreen>
    </Frame>
  );
}

export function AndroidForward({ number }: { number: string }) {
  return (
    <Frame variant="android">
      <AndroidScreen>
        <AndroidToolbar back title="Call forwarding" />
        <div className="px-2 pt-1">
          <p className="text-[9px] font-medium text-[#202124]">Always forward</p>
          <div className="mt-1 border-b-2 border-[#1a73e8] pb-0.5">
            <span className={cn("font-mono text-[8px] text-[#202124]", "mock-type")}>
              {shortNumber(number)}
            </span>
          </div>
          <div className="mock-press relative mt-2 flex justify-end gap-2 text-[8px] font-semibold text-[#1a73e8]">
            <span className="text-[#5f6368]">CANCEL</span>
            <span className="relative">
              <TapDot className="-right-1 top-1/2 -translate-y-1/2" />
              TURN ON
            </span>
          </div>
        </div>
      </AndroidScreen>
    </Frame>
  );
}

/* ------------------------------- Landline ------------------------------- */

export function LandlineKeypad({
  number,
  prefix,
  suffix = "",
}: {
  number: string;
  /** Activation prefix dialed before the number, e.g. "*72 " or "*21*". */
  prefix: string;
  /** Trailing character for GSM codes, e.g. "#". */
  suffix?: string;
}) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
  const sub: Record<string, string> = {
    "2": "ABC", "3": "DEF", "4": "GHI", "5": "JKL", "6": "MNO",
    "7": "PQRS", "8": "TUV", "9": "WXYZ",
  };
  // Highlight the control keys (* and #) so the code is easy to read at a glance —
  // shown statically, with no key-press/typing animation (users found the moving
  // demo confusing; they just need to see the exact number to dial).
  const hot = new Set(["*", ...(suffix.includes("#") ? ["#"] : [])]);
  return (
    <div className="relative mx-auto w-[150px] [zoom:1.35]">
      {/* Coiled cord — the giveaway landline detail, spiralling down the left */}
      <svg
        viewBox="0 0 20 80"
        className="absolute -left-2 top-9 z-0 h-[50%] w-3 text-neutral-400"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M13 2C4 4 4 11 13 13C4 15 4 22 13 24C4 26 4 33 13 35C4 37 4 44 13 46C4 48 4 55 13 57C7 59 5 66 11 70L16 79" />
      </svg>
      {/* Handset lying across the top — two ear/mouth cups joined by the grip */}
      <div className="relative z-20 mx-auto mb-[-8px] h-[19px] w-[102%]">
        <div className="absolute inset-x-7 top-[3px] h-3 rounded-full bg-gradient-to-b from-neutral-500 to-neutral-700 shadow-sm" />
        <div className="absolute left-0 top-0 h-[19px] w-8 rounded-[50%] bg-gradient-to-b from-neutral-500 to-neutral-800 shadow-sm" />
        <div className="absolute right-0 top-0 h-[19px] w-8 rounded-[50%] bg-gradient-to-b from-neutral-500 to-neutral-800 shadow-sm" />
      </div>
      {/* Desk-phone body */}
      <div className="relative z-10 rounded-[0.8rem] rounded-t-[1.5rem] bg-gradient-to-b from-neutral-200 to-neutral-300 p-[3px] shadow-[0_10px_22px_-8px_rgba(0,0,0,0.4)] ring-1 ring-black/5">
        <div className="rounded-[0.6rem] rounded-t-[1.3rem] bg-white px-2 pb-2.5 pt-2.5">
          {/* LCD display — shows the full code to dial, statically. */}
          <div className="mb-2 rounded-md bg-[#d7e3cf] px-1.5 py-1 text-center font-mono text-[10px] font-semibold tracking-wide text-[#2c3a24] shadow-[inset_0_1px_2px_rgba(0,0,0,0.15)]">
            <span className="align-bottom">
              {prefix}
              {shortNumber(number)}
              {suffix}
            </span>
          </div>
          {/* Keypad — static; the control keys stay highlighted for readability. */}
          <div className="grid grid-cols-3 gap-x-2 gap-y-1.5">
            {keys.map((k) => (
              <span
                key={k}
                className={cn(
                  "relative flex aspect-square flex-col items-center justify-center rounded-full text-[10px] font-semibold leading-none shadow-sm",
                  hot.has(k) ? "bg-[#007aff] text-white" : "bg-[#f2f2f4] text-[#1c1c1e]",
                )}
              >
                {k}
                {sub[k] && (
                  <span
                    className={cn(
                      "text-[3.5px] font-bold tracking-[0.5px]",
                      hot.has(k) ? "text-white/80" : "text-[#8e8e93]",
                    )}
                  >
                    {sub[k]}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandlineConfirm() {
  return (
    <div className="flex w-[144px] flex-col items-center justify-center gap-2 py-2 [zoom:1.4]">
      <div className="relative flex size-16 items-center justify-center rounded-full bg-primary-tint">
        {/* Sound-wave arcs radiating from the handset */}
        <span className="absolute size-16 animate-ping rounded-full border border-primary/30" />
        <PhoneCall className="size-7 text-primary" />
        <span className="absolute -right-0.5 -top-0.5 flex size-5 items-center justify-center rounded-full bg-success text-white ring-2 ring-background">
          <Check className="size-3" />
        </span>
      </div>
      <p className="text-xs font-semibold text-foreground">Forwarding on</p>
      <p className="text-[11px] text-muted-foreground">Wait for the tone</p>
    </div>
  );
}
