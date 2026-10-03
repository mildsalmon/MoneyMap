import { accountTree } from "../api/accountTree";
import type { Account, BalanceRow } from "../api/types";
import { fmtWon } from "../format";

type BalanceItem = { balance: BalanceRow; label: string };
type BalanceGroup = { id: number; name: string | null; items: BalanceItem[]; total: number };

/** API balances are own balances, never subtree totals. Sum each visible row once. */
export function groupDashboardBalances(accounts: Account[], balances: BalanceRow[]) {
  const rows = new Map(balances.map(b => [b.account_id, b]));
  const parents = new Set(accounts.map(a => a.parent_id));
  const groups = { asset: new Map<number, BalanceGroup>(), liability: new Map<number, BalanceGroup>() };
  const ancestors: Account[] = [];
  for (const { account, depth } of accountTree(accounts)) {
    ancestors.length = depth;
    ancestors.push(account);
    const b = rows.get(account.id);
    if (account.archived || !b || (account.type !== "asset" && account.type !== "liability")) continue;
    if (b.reporting_type !== "asset" && b.reporting_type !== "liability") continue;
    const isGroup = account.is_placeholder || parents.has(account.id);
    if (isGroup && b.balance === 0) continue;
    const root = ancestors[0];
    const grouped = root.is_placeholder || parents.has(root.id);
    const bucket = groups[b.reporting_type];
    let group = bucket.get(root.id);
    if (!group) {
      group = { id: root.id, name: grouped ? root.name : null, items: [], total: 0 };
      bucket.set(root.id, group);
    }
    const path = ancestors.slice(grouped ? 1 : 0).map(a => a.name).join(" / ");
    const label = isGroup ? (path ? `${path} / 직접 잔액` : "직접 잔액") : path;
    group.items.push({ balance: b, label });
    group.total += b.balance;
  }
  return { asset: [...groups.asset.values()], liability: [...groups.liability.values()] };
}

export function DashboardBalances({ accounts, balances, ready, unavailable, error, reload }: {
  accounts: Account[];
  balances: { accounts: BalanceRow[]; net_worth: number } | undefined;
  ready: boolean;
  unavailable: boolean;
  error: string | undefined;
  reload: () => void;
}) {
  const groups = groupDashboardBalances(accounts, balances?.accounts ?? []);
  return (
    <section aria-label="계정 잔액" className="dashboard-balances">
      {(["asset", "liability"] as const).map(type => (
        <table key={type} className="ledger" aria-label={type === "asset" ? "자산 잔액" : "부채 잔액"}>
          <thead><tr><th>{type === "asset" ? "자산" : "부채"}</th><th className="num">₩</th></tr></thead>
          {groups[type].map(group => (
            <tbody key={group.id}>
              {group.name !== null && <tr className="balance-group"><th colSpan={2} scope="rowgroup">{group.name}</th></tr>}
              {group.items.map(({ balance: b, label }) => (
                <tr key={b.account_id}>
                  <td className={`dashboard-account-cell${group.name !== null ? " balance-child" : ""}`}>
                    {label}
                    {b.reporting_type === "liability" && <span className="badge account-state-badge">
                      {b.type === "asset" ? "부채 · 마이너스 사용 중" : "부채"}
                    </span>}
                  </td>
                  <td className="num">{b.balance.toLocaleString("ko-KR")}</td>
                </tr>
              ))}
              {group.name !== null && <tr className="balance-subtotal"><td>{group.name} 소계</td><td className="num">{group.total.toLocaleString("ko-KR")}</td></tr>}
            </tbody>
          ))}
          {groups[type].length === 0 && <tbody><tr><td colSpan={2} className="balance-empty">
            {ready ? `표시할 ${type === "asset" ? "자산" : "부채"} 계정이 없습니다` : unavailable ? "계정 잔액을 확인할 수 없습니다" : "계정 잔액 확인 중"}
          </td></tr></tbody>}
        </table>
      ))}
      {error && <p className="cell-error" role="alert">계정 잔액을 불러오지 못함 <button className="retry-action" type="button" onClick={reload}>다시 시도</button></p>}
      <p className="balance-scope">소계는 표시된 활성 계정만 포함합니다.</p>
      <table className="ledger" aria-label="전체 순자산">
        <tbody><tr className="sum"><td>전체 순자산 (보관 계정 포함)</td><td className="num">{balances ? fmtWon(balances.net_worth) : "…"}</td></tr></tbody>
      </table>
    </section>
  );
}
