import * as React from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { INDUSTRIES, validateIndustry, normalizeIndustry, INDUSTRY_MAX_LEN } from "@/data/industries";

/**
 * Searchable industry picker built on {@link SearchableSelect}, with an "add your
 * own" path in the footer. Lists the built-in + admin-approved industries (fetched
 * live) as suggestions; when nothing matches, the user can type any custom
 * industry — applied to their profile immediately, no review, no submission.
 */
export function IndustryCombobox({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
}) {
  // Live list (built-ins + approved customs). Falls back to the bundled list
  // (minus the "Other" sentinel — the add-your-own row replaces it).
  const [options, setOptions] = React.useState<string[]>(() =>
    INDUSTRIES.filter((i) => i.toLowerCase() !== "other"),
  );

  React.useEffect(() => {
    let active = true;
    api.industries
      .list()
      .then((r) => {
        if (active && Array.isArray(r.industries) && r.industries.length) setOptions(r.industries);
      })
      .catch(() => {
        /* keep the bundled fallback */
      });
    return () => {
      active = false;
    };
  }, []);

  const addCustom = (raw: string, close: () => void) => {
    const result = validateIndustry(raw);
    if ("error" in result) return; // the footer button is disabled on invalid input
    // Any niche is accepted freely — apply the matching option (case-insensitive)
    // or the typed value as-is. No admin review, no toast.
    const existing = options.find((o) => o.toLowerCase() === result.value.toLowerCase());
    onChange(existing ?? result.value);
    close();
  };

  return (
    <SearchableSelect
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Select or type your industry"
      searchPlaceholder="Search or type your industry…"
      maxLength={INDUSTRY_MAX_LEN + 5}
      renderFooter={({ query, close }) => {
        // Only offer "add" when the typed value is genuinely new.
        if (!query) return null;
        const hasExact = options.some((o) => o.toLowerCase() === query.toLowerCase());
        if (hasExact) return null;
        const validation = validateIndustry(query);
        const error = "error" in validation ? validation.error : "";
        return (
          <>
            <button
              type="button"
              onClick={() => addCustom(query, close)}
              disabled={Boolean(error)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm",
                error
                  ? "cursor-not-allowed text-muted-foreground"
                  : "text-primary hover:bg-primary-tint",
              )}
            >
              <Plus className="size-3.5 shrink-0" />
              <span className="flex-1 truncate">Add &ldquo;{normalizeIndustry(query)}&rdquo;</span>
            </button>
            {error && <p className="px-2.5 pb-1 text-xs text-danger">{error}</p>}
          </>
        );
      }}
    />
  );
}
