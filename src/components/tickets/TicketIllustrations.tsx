import { cn } from "@/lib/utils";

// Spot illustrations for ticket empty states, drawn in the primary hue so they follow theme/dark mode/brand palette.

function Sparkle({ x, y, r = 4 }: { x: number; y: number; r?: number }) {
  return (
    <path
      d={`M${x} ${y - r} L${x + r * 0.35} ${y - r * 0.35} L${x + r} ${y} L${x + r * 0.35} ${y + r * 0.35} L${x} ${y + r} L${x - r * 0.35} ${y + r * 0.35} L${x - r} ${y} L${x - r * 0.35} ${y - r * 0.35} Z`}
      className="fill-primary/40"
    />
  );
}

/** An envelope with a letter lifting out and a paper plane on its way. */
export function MailEmptyIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 180 130" aria-hidden="true" className={cn("h-32 w-auto", className)} fill="none">
      <ellipse cx="82" cy="118" rx="46" ry="5" className="fill-primary/10" />
      <rect x="40" y="58" width="84" height="54" rx="9" className="fill-primary/20" />
      <rect x="52" y="34" width="60" height="58" rx="5" className="fill-card" />
      <rect x="52" y="34" width="60" height="58" rx="5" className="stroke-primary/25" strokeWidth="1.5" />
      <rect x="61" y="46" width="42" height="3" rx="1.5" className="fill-primary/35" />
      <rect x="61" y="55" width="34" height="3" rx="1.5" className="fill-primary/25" />
      <rect x="61" y="64" width="38" height="3" rx="1.5" className="fill-primary/25" />
      <path d="M40 72 L82 100 L124 72 V103 A9 9 0 0 1 115 112 H49 A9 9 0 0 1 40 103 Z" className="fill-primary/45" />
      <path d="M40 72 L82 100 L124 72" className="stroke-primary/30" strokeWidth="1.5" />
      <path
        d="M118 52 C 128 48, 134 40, 148 34"
        className="stroke-primary/40"
        strokeWidth="1.5"
        strokeDasharray="3 4"
        strokeLinecap="round"
      />
      <path d="M150 22 L166 30 L150 40 L152 32 Z" className="fill-primary" />
      <path d="M150 22 L152 32 L166 30 Z" className="fill-primary/70" />
      <Sparkle x={28} y={44} />
      <Sparkle x={146} y={66} r={3} />
      <circle cx="36" cy="30" r="1.5" className="fill-primary/40" />
      <circle cx="140" cy="18" r="1.5" className="fill-primary/40" />
      <circle cx="132" cy="90" r="1.5" className="fill-primary/40" />
    </svg>
  );
}

/** An empty inbox tray with a speech bubble dozing above it. */
export function InboxEmptyIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 150" aria-hidden="true" className={cn("h-36 w-auto", className)} fill="none">
      <ellipse cx="100" cy="136" rx="56" ry="6" className="fill-primary/10" />
      <path
        d="M30 118 C 36 110, 44 112, 46 118 S 58 126, 64 118"
        className="stroke-primary/25"
        strokeWidth="1.5"
        strokeDasharray="3 4"
        strokeLinecap="round"
      />
      <path d="M62 64 H138 L156 96 H44 Z" className="fill-primary/20" />
      <path d="M52 92 H148 V100 H52 Z" className="fill-primary/60" />
      <rect x="44" y="96" width="112" height="32" rx="8" className="fill-primary/45" />
      <rect x="86" y="108" width="28" height="4" rx="2" className="fill-primary/40" />
      <path
        d="M80 20 H120 A10 10 0 0 1 130 30 V50 A10 10 0 0 1 120 60 H98 L88 70 V60 H80 A10 10 0 0 1 70 50 V30 A10 10 0 0 1 80 20 Z"
        className="fill-card"
      />
      <path
        d="M80 20 H120 A10 10 0 0 1 130 30 V50 A10 10 0 0 1 120 60 H98 L88 70 V60 H80 A10 10 0 0 1 70 50 V30 A10 10 0 0 1 80 20 Z"
        className="stroke-primary/30"
        strokeWidth="1.5"
      />
      <rect x="88" y="38" width="6" height="2" rx="1" className="fill-primary/60" />
      <rect x="106" y="38" width="6" height="2" rx="1" className="fill-primary/60" />
      <path
        d="M96 48 C 98 51, 102 51, 104 48"
        className="stroke-primary/60"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <Sparkle x={50} y={44} />
      <Sparkle x={150} y={52} r={3.5} />
      <Sparkle x={140} y={28} r={2.5} />
      <circle cx="42" cy="66" r="1.5" className="fill-primary/40" />
      <circle cx="164" cy="80" r="1.5" className="fill-primary/40" />
    </svg>
  );
}

/** A clipboard with a star badge — nothing has been scored yet. */
export function RatingsEmptyIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 150" aria-hidden="true" className={cn("h-36 w-auto", className)} fill="none">
      <circle cx="122" cy="82" r="46" className="fill-primary/10" />
      <circle cx="82" cy="98" r="30" className="fill-primary/10" />
      <rect x="66" y="30" width="72" height="92" rx="10" className="fill-primary/25" />
      <rect x="75" y="42" width="54" height="72" rx="6" className="fill-card" />
      <rect x="88" y="23" width="28" height="14" rx="5" className="fill-primary/45" />
      <rect x="86" y="58" width="32" height="4" rx="2" className="fill-primary/30" />
      <rect x="86" y="70" width="24" height="4" rx="2" className="fill-primary/25" />
      <rect x="86" y="82" width="28" height="4" rx="2" className="fill-primary/25" />
      <circle cx="132" cy="106" r="18" className="fill-primary" />
      <g transform="translate(132 106)">
        <polygon
          points="0,-9 2.35,-3.24 8.56,-2.78 3.8,1.24 5.29,7.28 0,4 -5.29,7.28 -3.8,1.24 -8.56,-2.78 -2.35,-3.24"
          className="fill-primary-foreground"
        />
      </g>
      <Sparkle x={58} y={40} r={3} />
      <Sparkle x={152} y={56} r={3.5} />
      <Sparkle x={52} y={96} r={2.5} />
      <Sparkle x={160} y={120} r={2.5} />
      <circle cx="146" cy="36" r="1.5" className="fill-primary/40" />
      <circle cx="48" cy="72" r="1.5" className="fill-primary/40" />
    </svg>
  );
}
