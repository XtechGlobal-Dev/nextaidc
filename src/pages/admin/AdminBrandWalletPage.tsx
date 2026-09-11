import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { api, type BrandWallet } from "@/lib/api";
import { BrandWalletSection } from "@/pages/admin/brands/BrandWalletSection";

/** A brand admin's wallet: what the platform owes the brand and what it has paid. */
export default function AdminBrandWalletPage() {
  const [wallet, setWallet] = useState<BrandWallet | null>(null);

  useEffect(() => {
    let active = true;
    api.brandAdmin
      .wallet()
      .then((w) => active && setWallet(w))
      .catch(() => active && setWallet({ balances: [], entries: [] }));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div>
      <PageHeader
        title="Wallet"
        subtitle="Your addon share of every paid invoice, and the payouts the platform has made to you."
      />
      <BrandWalletSection wallet={wallet} />
    </div>
  );
}
