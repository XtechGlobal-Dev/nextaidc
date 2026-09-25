import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Check,
  GripVertical,
  LayoutTemplate,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  MousePointer2,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  Zap,
  ZapOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CallLayout } from "@/lib/livekit";
import { cn, formatDuration } from "@/lib/utils";

// The small toolbar that floats over everything while this browser is sharing its screen — the
// call window may be minimised or behind other things, this stays in reach. Drag it by its
// handle; it starts top-centre.

export type ShareAudio = "on" | "off" | "none";
/** Pointer control, as the sharer sees it: nobody has it, the viewer asked, or the viewer has it. */
export type ShareControl = "none" | "requested" | "granted";

interface Props {
  muted: boolean;
  cameraOn: boolean;
  shareAudio: ShareAudio;
  optimized: boolean;
  layout: CallLayout;
  control: ShareControl;
  /** Who is watching — named in the control prompt. */
  viewerName: string;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onToggleShareAudio: () => void;
  onToggleOptimized: () => void;
  onLayout: (layout: CallLayout) => void;
  onGiveControl: () => void;
  onTakeBackControl: () => void;
  onDenyControl: () => void;
  onStop: () => void;
}

const MARGIN = 8;

const LAYOUTS: { value: CallLayout; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { value: "content", label: "Content only", icon: Monitor },
  { value: "content-people", label: "Content + people", icon: LayoutTemplate },
];

export function ScreenShareBar({
  muted,
  cameraOn,
  shareAudio,
  optimized,
  layout,
  control,
  viewerName,
  onToggleMute,
  onToggleCamera,
  onToggleShareAudio,
  onToggleOptimized,
  onLayout,
  onGiveControl,
  onTakeBackControl,
  onDenyControl,
  onStop,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clamp(p, ref.current) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function onDragStart(e: ReactPointerEvent<HTMLDivElement>) {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onDrag(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    setPos(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }, ref.current));
  }
  function onDragEnd(e: ReactPointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Screen sharing controls"
      className="pointer-events-auto fixed z-[1310] flex items-stretch gap-0.5 rounded-xl border border-border bg-background/95 p-1 shadow-2xl backdrop-blur"
      style={pos ? { left: pos.x, top: pos.y } : { left: "50%", top: MARGIN, transform: "translateX(-50%)" }}
    >
      <div
        className="flex cursor-grab touch-none select-none items-center gap-1.5 rounded-lg px-1.5 hover:bg-muted active:cursor-grabbing"
        onPointerDown={onDragStart}
        onPointerMove={onDrag}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        title="Drag to move"
      >
        <GripVertical className="size-4 text-muted-foreground" />
        <span className="text-xs tabular-nums text-muted-foreground">{formatDuration(seconds)}</span>
      </div>
      <BarButton icon={cameraOn ? Video : VideoOff} label="Camera" active={cameraOn} onClick={onToggleCamera} />
      <BarButton icon={muted ? MicOff : Mic} label="Mic" active={!muted} onClick={onToggleMute} />
      <Divider />
      <BarButton
        icon={shareAudio === "on" ? Volume2 : VolumeX}
        label="Share sound"
        active={shareAudio === "on"}
        disabled={shareAudio === "none"}
        title={
          shareAudio === "none"
            ? "No sound is being shared — tick “Share audio” in the browser's picker when you start sharing"
            : shareAudio === "on"
              ? "Stop sharing sound"
              : "Share your computer's sound"
        }
        onClick={onToggleShareAudio}
      />
      <BarButton
        icon={optimized ? Zap : ZapOff}
        label="Optimize"
        active={optimized}
        title={
          optimized
            ? "Optimised for video — click for sharper text"
            : "Optimise for video: smoother motion, less sharp text"
        }
        onClick={onToggleOptimized}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <BarButton icon={LayoutTemplate} label="Layout" title="How the other side sees your share" />
        </DropdownMenuTrigger>
        {/* Above the call window (z-1300), which these menus open over. */}
        <DropdownMenuContent align="center" className="z-[1320]">
          {LAYOUTS.map((l) => (
            <DropdownMenuItem key={l.value} onSelect={() => onLayout(l.value)}>
              <span className={cn("grid size-4 place-items-center", layout !== l.value && "invisible")}>
                <Check />
              </span>
              <l.icon className="size-4" /> {l.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <BarButton
        icon={MousePointer2}
        label={control === "granted" ? "Take back" : "Give control"}
        active={control === "granted"}
        attention={control === "requested"}
        title={
          control === "granted"
            ? `Stop ${viewerName} pointing on your screen`
            : `Let ${viewerName} point on your screen (a shared pointer — they can't click for you)`
        }
        onClick={control === "granted" ? onTakeBackControl : onGiveControl}
      />
      <Divider />
      <BarButton icon={MonitorOff} label="Stop sharing" danger onClick={onStop} />

      {control === "requested" && (
        <div
          role="alert"
          className="absolute left-1/2 top-full mt-2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-xl border border-border bg-background px-3 py-2 text-xs shadow-xl"
        >
          <MousePointer2 className="size-4 text-primary" />
          <span>
            <span className="font-medium">{viewerName}</span> wants to point on your screen
          </span>
          <Button size="sm" className="h-7" onClick={onGiveControl}>
            Allow
          </Button>
          <Button size="sm" variant="outline" className="h-7" onClick={onDenyControl}>
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <span aria-hidden="true" className="mx-0.5 my-1 w-px bg-border" />;
}

interface BarButtonProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  /** Something is waiting on this button — a pulsing dot. */
  attention?: boolean;
}

const BarButton = forwardRef<HTMLButtonElement, BarButtonProps>(function BarButton(
  { icon: Icon, label, onClick, active, disabled, danger, title, attention, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={title ?? label}
      className={cn(
        "relative flex min-w-14 flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        active && "text-foreground",
        danger && "text-danger hover:bg-danger-tint hover:text-danger",
      )}
      {...rest}
    >
      {attention && (
        <span className="absolute right-1.5 top-1 size-2 rounded-full bg-primary motion-safe:animate-pulse" />
      )}
      <Icon className="size-4" />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
});

function clamp(p: { x: number; y: number }, el: HTMLElement | null) {
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  return {
    x: Math.min(Math.max(MARGIN, p.x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
    y: Math.min(Math.max(MARGIN, p.y), Math.max(MARGIN, window.innerHeight - h - MARGIN)),
  };
}
