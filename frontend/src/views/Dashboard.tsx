import { useCallback, useEffect, useMemo, useState } from "react";
import { api, chartToggles, type Account, type BalanceRow, type Series, type Txn } from "../api";
import { fmtWon, todayIso } from "../format";
import { ProjectionChart } from "../chart/ProjectionChart";
import type { ViewProps } from "../App";

const FUTURE = [
  { m: 6, label: "6개월" },
  { m: 12, label: "1년" },
  { m: 36, label: "3년" },
  { m: 60, label: "5년" },
];

export function Dashboard({ gen, go }: ViewProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState<{ net_worth: number; accounts: BalanceRow[] } | null>(null);
  const [balancesError, setBalancesError] = useState("");
  const [txns, setTxns] = useState<Txn[]>([]);
  const [rulesCount, setRulesCount] = useState(0);
  const [months, setMonths] = useState(12);
  const [series, setSeries] = useState<Series[] | null>(null);
  const [stale, setStale] = useState(false); // 리페치 중 이전 렌더 유지 + 디밍

  const loadBalances = useCallback(() => {
    setBalances(null);
    setBalancesError("");
    api.balances().then(setBalances).catch((error: Error) => setBalancesError(error.message));
  }, []);

  useEffect(() => {
    api.accounts().then(setAccounts);
    loadBalances();
    api.transactions().then(setTxns);
    api.rules().then((r) => setRulesCount(r.length));
  }, [gen, loadBalances]);

  useEffect(() => {
    setStale(true);
    const ids = chartToggles.get();
    api.projection(months, ids).then(({ series }) => {
      setSeries(series.filter((s) => s.points.length > 0));
      setStale(false);
    });
  }, [months, gen]);

  const month = todayIso().slice(0, 7);
  const typeOf = useMemo(() => new Map(accounts.map((a) => [a.id, a.type])), [accounts]);

  const { income, expense, topExpense } = useMemo(() => {
    let income = 0, expense = 0;
    const byExpense = new Map<number, number>();
    for (const t of txns) {
      if (!t.date.startsWith(month)) continue;
      for (const p of t.postings) {
        const ty = typeOf.get(p.account_id);
        if (ty === "income") income += -p.amount.amount; // 수익은 대변(−)
        if (ty === "expense") {
          expense += p.amount.amount;
          byExpense.set(p.account_id, (byExpense.get(p.account_id) ?? 0) + p.amount.amount);
        }
      }
    }
    const topExpense = [...byExpense.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return { income, expense, topExpense };
  }, [txns, month, typeOf]);

  // 온보딩 (D11): 3단계 완료 전에는 빈 차트를 보여주지 않는다
  const hasAccounts = accounts.some((a) => (a.type === "asset" || a.type === "liability") && !a.archived);
  // 개시잔액: 실제 기록(거래) 또는 0원 확인이 하나라도 있으면 완료로 본다
  // (0원 확인은 거래를 만들 수 없어 localStorage 표시 — 계정 화면의 "기록" 버튼)
  const [zeroConfirmed] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("moneymap.opening_zero") ?? "[]");
    } catch {
      return [];
    }
  });
  const hasOpening =
    txns.length > 0 ||
    zeroConfirmed.length > 0 ||
    localStorage.getItem("moneymap.opening_skipped") === "1"; // 구버전 호환
  const hasRules = rulesCount > 0;
  if (balances && !(hasAccounts && hasOpening)) {
    const steps = [
      { done: hasAccounts, label: "계정 만들기 — 통장·카드·대출 등록", goTo: "accounts" as const },
      { done: hasOpening, label: "개시잔액 입력 — 잔액이 0원이어도 '기록'으로 확인", goTo: "accounts" as const },
      { done: hasRules, label: "반복 규칙 등록 — 월급·월세·카드값", goTo: "rules" as const },
    ];
    const next = steps.find((s) => !s.done);
    return (
      <div className="empty-wrap">
        <div className="empty">
          <h2 style={{ fontSize: 19, marginBottom: 6 }}>장부를 시작해볼까요?</h2>
          <p style={{ color: "var(--muted)", fontSize: 13.5 }}>세 단계면 첫 미래 자산 곡선을 볼 수 있습니다.</p>
          <div className="steps">
            {steps.map((s, i) => (
              <div key={i} className={`step ${s.done ? "done" : ""}`}>
                <span className="n">{s.done ? "✓" : i + 1}</span>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
          {next && (
            <button className="btn primary" onClick={() => go(next.goTo)}>
              {steps.indexOf(next) + 1}단계 — {next.label.split(" — ")[0]} →
            </button>
          )}
          <p style={{ color: "var(--faint)", fontSize: 12, marginTop: 10 }}>완료하면 이 자리에 순자산 차트가 나타납니다</p>
        </div>
      </div>
    );
  }

  // 보관 계정은 잔액이 남아 있을 때만 표시 (0원이면 숨김 — D23)
  const archivedIds = new Set(accounts.filter((a) => a.archived).map((a) => a.id));
  const acctBalances = (balances?.accounts ?? []).filter(
    (b) =>
      (b.type === "asset" || b.type === "liability") &&
      (!archivedIds.has(b.account_id) || b.balance !== 0),
  );

  return (
    <div>
      {/* 상단: 테두리 없는 순자산 스트립 (D6) */}
      <div className="strip">
        <div className="cell">
          <label>순자산 (오늘)</label>
          <div className="hero">{balances ? fmtWon(balances.net_worth) : "…"}</div>
        </div>
        <div className="cell">
          <label>이번 달 수입</label>
          <div className="v num">{fmtWon(income)}</div>
        </div>
        <div className="cell">
          <label>이번 달 지출</label>
          <div className="v num">{fmtWon(expense)}</div>
        </div>
      </div>

      {/* 필터 한 줄 — 미래 창 (D19) */}
      <div className="filters">
        미래:
        <div className="seg">
          {FUTURE.map((f) => (
            <button key={f.m} className={months === f.m ? "on" : ""} onClick={() => setMonths(f.m)}>
              {f.label}
            </button>
          ))}
        </div>
        <span style={{ color: "var(--faint)" }}>· 과거는 기록 시작일부터 · 시나리오 표시는 시나리오 탭에서 (최대 3개)</span>
      </div>

      {/* 차트 워크벤치 — full-width, 카드에 가두지 않음 */}
      <div style={{ opacity: stale ? 0.55 : 1, transition: "opacity .15s" }}>
        {series && series.length > 0 && <ProjectionChart series={series} today={todayIso()} />}
      </div>

      {/* 하단: 컴팩트 테이블 */}
      <div className="two">
        <div>
          <table className="ledger">
            <thead><tr><th>계정 잔액</th><th className="num">₩</th></tr></thead>
            <tbody>
              {acctBalances.map((b) => (
                <tr key={b.account_id}>
                  <td className="dashboard-account-cell">
                    {b.name}
                    {b.type === "asset" && b.reporting_type === "liability" ? (
                      <span className="badge account-state-badge">부채 · 마이너스 사용 중</span>
                    ) : b.reporting_type === "liability" ? (
                      <span className="badge account-state-badge">부채</span>
                    ) : null}
                  </td>
                  <td className="num">{b.balance.toLocaleString("ko-KR")}</td>
                </tr>
              ))}
              {balancesError && (
                <tr>
                  <td colSpan={2} className="cell-error" role="alert">
                    계정 잔액을 불러오지 못함
                    <button className="retry-action" type="button" onClick={loadBalances}>다시 시도</button>
                  </td>
                </tr>
              )}
              <tr className="sum">
                <td>순자산 (검산 일치)</td>
                <td className="num">{balances ? fmtWon(balances.net_worth) : "…"}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <table className="ledger">
            <thead><tr><th>이번 달 지출 상위</th><th className="num">₩</th></tr></thead>
            <tbody>
              {topExpense.map(([id, amt]) => (
                <tr key={id}>
                  <td>{accounts.find((a) => a.id === id)?.name ?? id}</td>
                  <td className="num">{amt.toLocaleString("ko-KR")}</td>
                </tr>
              ))}
              {topExpense.length === 0 && (
                <tr><td colSpan={2} style={{ color: "var(--muted)" }}>이번 달 지출 기록이 없습니다</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
