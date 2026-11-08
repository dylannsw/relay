import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { labelIcon } from "@/components/app-sidebar";
import type { Account } from "@/types";

/** The account a message belongs to, as a chip tinted with the account's color. */
export function AccountChip({ account, className }: { account: Account; className?: string }) {
  const Icon = labelIcon(account.label);
  return (
    <Badge
      variant="tint"
      className={cn("justify-start", className)}
      style={{ "--chip": account.color } as CSSProperties}
      title={`${account.label} · ${account.email}`}
    >
      <Icon />
      <span className="truncate">{account.email}</span>
    </Badge>
  );
}
