import * as React from "react";
import { cn } from "@/lib/utils";

interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  invalid?: boolean;
  autoFocus?: boolean;
  /** Locks every box — typing, pasting and focus all stop. */
  disabled?: boolean;
  /** Applied to the first box so a <Label htmlFor> still points somewhere sensible. */
  id?: string;
}

/** Segmented numeric code input — one box per digit, with auto-advance, backspace,
 *  arrow-key navigation and paste support. Value is the joined digit string. */
export function OtpInput({
  value,
  onChange,
  length = 6,
  invalid,
  autoFocus,
  disabled,
  id,
}: OtpInputProps) {
  const inputs = React.useRef<(HTMLInputElement | null)[]>([]);
  const chars = Array.from({ length }, (_, i) => value[i] ?? "");

  // Guarded here as well as on the inputs: paste and the arrow/backspace handler
  // both move focus themselves, and a disabled box is not focusable — so without
  // this they would throw the caret at a dead element.
  const update = (next: string) => {
    if (disabled) return;
    onChange(next.replace(/\D/g, "").slice(0, length));
  };
  const focus = (i: number) => {
    if (disabled) return;
    inputs.current[Math.max(0, Math.min(i, length - 1))]?.focus();
  };

  function handleChange(i: number, raw: string) {
    const digits = raw.replace(/\D/g, "");
    if (!digits) return;
    const arr = chars.slice();
    for (let k = 0; k < digits.length && i + k < length; k++) arr[i + k] = digits[k];
    update(arr.join(""));
    focus(i + digits.length);
  }

  function handleKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      e.preventDefault();
      const arr = chars.slice();
      if (arr[i]) {
        arr[i] = "";
        update(arr.join(""));
      } else if (i > 0) {
        arr[i - 1] = "";
        update(arr.join(""));
        focus(i - 1);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focus(i - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focus(i + 1);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (!text) return;
    update(text);
    focus(text.length);
  }

  return (
    <div className="flex justify-between gap-2">
      {chars.map((c, i) => (
        <input
          key={i}
          ref={(el) => {
            inputs.current[i] = el;
          }}
          id={i === 0 ? id : undefined}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={1}
          autoFocus={autoFocus && i === 0 && !disabled}
          disabled={disabled}
          value={c}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.currentTarget.select()}
          aria-invalid={invalid}
          aria-label={`Digit ${i + 1}`}
          className={cn(
            "h-12 w-full min-w-0 rounded-xl border bg-background text-center text-lg font-semibold",
            "outline-none focus-visible:focus-ring",
            invalid ? "border-danger" : "border-border",
            disabled && "cursor-not-allowed border-border bg-muted/50 text-muted-foreground",
          )}
        />
      ))}
    </div>
  );
}
