import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhoneInput } from "./phone-input";

// The visitor's region comes from their timezone (data/countries.ts guessCountry).
function inTimezone(timeZone: string) {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...real.call(this), timeZone };
  });
}

/** The field as the test-call dialogs use it: the parent owns the value and may fill it in later. */
function Harness({ onValue }: { onValue?: (v: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <>
      <PhoneInput
        id="n"
        value={value}
        onChange={(v) => {
          setValue(v);
          onValue?.(v);
        }}
      />
      <button type="button" onClick={() => setValue((v) => v || "+919865325263")}>
        load saved
      </button>
    </>
  );
}

const countryButton = () => screen.getByRole("button", { name: "Select country code" });
const number = () => screen.getByRole("textbox") as HTMLInputElement;

afterEach(() => vi.restoreAllMocks());

describe("PhoneInput", () => {
  it("starts on the visitor's own region when there's no number yet", () => {
    inTimezone("Australia/Sydney");
    render(<Harness />);
    expect(countryButton()).toHaveTextContent("+61");
  });

  it("follows a saved number that arrives after mount", async () => {
    inTimezone("Australia/Sydney");
    render(<Harness />);
    await act(async () => screen.getByRole("button", { name: "load saved" }).click());
    expect(countryButton()).toHaveTextContent("+91");
    expect(number().value).toBe("9865325263");
  });

  it("keeps a typed leading 0 while emitting the E.164 number", async () => {
    inTimezone("Australia/Sydney");
    const seen: string[] = [];
    render(<Harness onValue={(v) => seen.push(v)} />);
    await userEvent.type(number(), "0412345678");
    expect(number().value).toBe("0412345678");
    expect(seen.at(-1)).toBe("+61412345678");
  });
});
