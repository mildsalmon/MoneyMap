import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { todayIso } from "../format";
import { historySearch } from "./historyQueryState";

/** Balance links explain cumulative postings; flow links pass their own period. */
export function AccountHistoryLink({ accountId, children, pathname = "/transactions", start = "0001-01-01", end = todayIso(), includeChildren = true, tag = "", className = "" }: {
  pathname?: string; accountId: number; children: ReactNode; start?: string; end?: string; includeChildren?: boolean; tag?: string; className?: string;
}) {
  return <Link title={typeof children === "string" ? children : undefined} className={`account-history-link ${className}`} to={{ pathname, search: historySearch({
    start, end, tag, page: 1, accountId: String(accountId), accountScope: includeChildren ? "subtree" : "direct",
  }) }}>{children}</Link>;
}
