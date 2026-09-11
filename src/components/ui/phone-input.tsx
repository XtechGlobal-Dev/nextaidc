import * as React from "react";
import { ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  COUNTRIES,
  countryFromValue,
  flagUrl,
  guessCountry,
  nationalDigits,
  toE164,
  type Country,
} from "@/data/countries";

type PhoneInputProps = {
  /** Full phone value, e.g. "+15551234567". */
  value: string;
  onChange: (value: string) => void;
  /** Fired when the number input loses focus — used to commit edits on blur. */
  onBlur?: () => void;
  id?: string;
  placeholder?: string;
  className?: string;
  /** Native autocomplete hint for the number field, e.g. "off" to suppress autofill. */
  autoComplete?: string;
  "aria-invalid"?: boolean;
};

const Flag = ({ country }: { country: Country }) => (
  <img
    src={flagUrl(country.code)}
    alt=""
    width={20}
    height={15}
    loading="lazy"
    className="h-[15px] w-5 shrink-0 rounded-[2px] object-cover"
  />
);

export function PhoneInput({
  value,
  onChange,
  onBlur,
  id,
  placeholder,
  className,
  autoComplete,
  "aria-invalid": invalid,
}: PhoneInputProps) {
  // With no number yet, default the dial code to the visitor's own region rather
  // than always US; an existing value derives its country from the digits.
  const [country, setCountry] = React.useState<Country>(() =>
    value ? countryFromValue(value) : guessCountry(),
  );
  const [national, setNational] = React.useState(() => {
    const prefix = `+${country.dial}`;
    return value.startsWith(prefix) ? value.slice(prefix.length) : "";
  });
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

  // Stored value is canonical E.164 — toE164 drops a leading "0" trunk code the user
  // may have typed (India/AU/UK) so the number is valid, while the field keeps it.
  const emit = (c: Country, digits: string) => onChange(toE164(c, digits));

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const filtered = query.trim()
    ? COUNTRIES.filter((c) => {
        const q = query.trim().toLowerCase();
        return c.name.toLowerCase().includes(q) || c.dial.includes(q.replace(/^\+/, ""));
      })
    : COUNTRIES;

  // Keep the highlighted row in view as the user arrows through the list.
  React.useEffect(() => {
    if (open) itemRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const openMenu = () => {
    const selected = filtered.findIndex((c) => c.code === country.code);
    setActive(selected >= 0 ? selected : 0);
    setOpen(true);
  };

  const pickCountry = (c: Country) => {
    // Keep the digits the user already typed (re-capped to the new country's
    // max length) — we never silently rewrite their input on a country switch.
    // Validity under the new country is surfaced by `phoneError`, not by mutation.
    const digits = nationalDigits(c, national);
    setCountry(c);
    setNational(digits);
    setOpen(false);
    setQuery("");
    emit(c, digits);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const choice = filtered[active];
      if (choice) pickCountry(choice);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  const onNationalChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digits = nationalDigits(country, e.target.value);
    setNational(digits);
    emit(country, digits);
  };

  return (
    <div ref={rootRef} className="relative">
      <div
        className={cn(
          "flex h-10 w-full items-center rounded-xl border border-border bg-background text-sm focus-within:focus-ring",
          invalid && "border-danger",
          className,
        )}
      >
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openMenu())}
          aria-label="Select country code"
          aria-expanded={open}
          className="flex h-full items-center gap-1.5 rounded-l-xl pl-3 pr-2 text-foreground hover:bg-muted"
        >
          <Flag country={country} />
          <span className="text-muted-foreground">+{country.dial}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </button>
        <span className="h-5 w-px bg-border" />
        <input
          id={id}
          type="tel"
          inputMode="tel"
          value={national}
          onChange={onNationalChange}
          onBlur={onBlur}
          placeholder={placeholder}
          autoComplete={autoComplete}
          aria-invalid={invalid}
          className="h-full flex-1 rounded-r-xl bg-transparent px-3 outline-none placeholder:text-muted-foreground"
        />
      </div>

      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-50 w-full min-w-[16rem] overflow-hidden rounded-xl border border-border bg-background shadow-[var(--shadow-panel)]">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onMenuKeyDown}
              placeholder="Search country"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">No matches</li>
            ) : (
              filtered.map((c, i) => (
                <li key={c.code}>
                  <button
                    type="button"
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    onClick={() => pickCountry(c)}
                    onMouseMove={() => setActive(i)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm",
                      i === active && "bg-primary-tint text-primary",
                      c.code === country.code && "font-medium",
                    )}
                  >
                    <Flag country={c} />
                    <span className="flex-1 truncate">{c.name}</span>
                    <span className={cn("text-muted-foreground", i === active && "text-primary")}>
                      +{c.dial}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
