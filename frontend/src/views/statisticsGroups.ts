import { accountTree } from "../api/accountTree";
import type { Account } from "../api/types";
import type { Statistics as StatisticsData } from "../api/statistics";

type Group = { id: number; name: string | null; total: bigint; items: { id: number; label: string; value: number; archived: boolean }[] };
/** Group direct amounts once; historical group postings are separate own rows. */
export function groupStatistics(data: StatisticsData, kind: "income" | "expense" | "asset" | "liability"): Group[] {
  const balances = new Map(data.balances.map(row => [row.account_id, row]));
  const parents = new Set(data.accounts.map(a => a.parent_id));
  const groups = new Map<number, Group>();
  const ancestors: Account[] = [];
  for (const { account, depth } of accountTree(data.accounts)) {
    ancestors.length = depth; ancestors.push(account);
    const row = balances.get(account.id);
    if (!row) continue;
    const flow = kind === "income" || kind === "expense";
    if (flow ? account.type !== kind || !row.activity : row.reporting_type !== kind || !row.balance) continue;
    const value = flow ? row.period * (kind === "income" ? -1 : 1) : row.balance * (kind === "liability" ? -1 : 1);
    const root = ancestors[0], grouped = root.is_placeholder || parents.has(root.id);
    let group = groups.get(root.id);
    if (!group) {
      group = { id: root.id, name: grouped ? root.name : null, total: 0n, items: [] };
      groups.set(root.id, group);
    }
    const path = ancestors.slice(grouped ? 1 : 0).map(a => a.name).join(" / ");
    const ownGroup = account.is_placeholder || parents.has(account.id);
    const label = ownGroup ? `${path ? `${path} / ` : ""}직접 기록` : path;
    group.items.push({ id: account.id, label, value, archived: account.archived });
    group.total += BigInt(value);
  }
  return [...groups.values()];
}
