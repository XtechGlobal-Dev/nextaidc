import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { api, type BrandPricing } from "@/lib/api";
import { BrandPricingSection } from "@/pages/admin/brands/BrandPricingSection";

/** Brand admin's own price list: platform base price + the brand's addon, only if the platform allows it and within its cap. */
export default function AdminBrandPricingPage() {
  const [pricing, setPricing] = useState<BrandPricing | null>(null);

  useEffect(() => {
    let active = true;
    api.brandAdmin
      .pricing()
      .then((p) => active && setPricing(p))
      .catch(() => active && setPricing({ rows: [], addonEditable: false, maxAddonCents: null }));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div>
      <PageHeader
        title="Price addon"
        subtitle="What your customers pay for each plan: the platform's base price plus your addon."
      />
      <BrandPricingSection
        pricing={pricing}
        canEdit={pricing?.addonEditable ?? false}
        onSave={async (planId, addonCents) => {
          const row = await api.brandAdmin.setAddon(planId, addonCents);
          setPricing((p) =>
            p ? { ...p, rows: p.rows.map((r) => (r.planId === planId ? row : r)) } : p,
          );
          return row;
        }}
        intro="Your customers pay the total to the platform. Your addon on every paid invoice is credited to your wallet, and the platform pays it out to you."
      />
    </div>
  );
}
