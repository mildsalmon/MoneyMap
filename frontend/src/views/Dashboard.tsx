import { useMemo, useState } from "react";
import { api, chartToggles } from "../api";
import { fmtWon, todayIso } from "../format";
import { ProjectionChart } from "../chart/ProjectionChart";
import type { ViewProps } from "../App";
import { useQuery } from "./scenarios/useQuery";

const FUTURE = [
  { m: 6, label: "6개월" },
  { m: 12, label: "1년" },
  { m: 3, label: "3개월" },
];

export function Dashboard({ gen, go }: ViewProps) {
  const [months, setMonths] = useState(12);
  const supportQuery = useQuery(`dashboard-inputs:${gen}`, signal => Promise.all([api.accounts(signal), api.transactions(1, signal), api.rules(1, signal)]));
  const balancesQuery = useQuery(`dashboard-balances:${gen}`, signal => api.balances(1, signal));
  const projectionQuery = useQuery(`dashboard-projection:${months}:${gen}`, signal => api.projection(months, chartToggles.get(), signal));
  const accounts = supportQuery.data?.[0] ?? [];
  const txns = supportQuery.data?.[1] ?? [];
  const rulesCount = supportQuery.data?.[2].length ?? 0;
  const balances = balancesQuery.data;
  const balancesError = balancesQuery.error;
  const series = projectionQuery.data?.series.filter(series => series.points.length > 0);

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
  if (balances && supportQuery.data && !(hasAccounts && hasOpening)) {
    const steps = [
      { done: hasAccounts, label: "계정 만들기 — 통장·카드·대출 등록", goTo: "accounts" as const },
      { done: hasOpening, label: "개시잔액 입력 — 잔액이 0원이어도 '기록'으로 확인", goTo: "accounts" as const },
      { done: hasRules, label: "반복 규칙 등록 — 월급·월세·카드값", goTo: "rules" as const },
    ];
    const next = steps.find((s) => !s.done);
    return (
      <div className="empty-wrap">
        <div className="empty">
          <h1 style={{ fontSize: 19, marginBottom: 6 }}>장부를 시작해볼까요?</h1>
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
      {supportQuery.error && <p role="alert">장부 정보를 불러오지 못했습니다. {supportQuery.error} <button className="btn secondary" onClick={supportQuery.reload}>다시 불러오기</button></p>}
      {!supportQuery.data && !supportQuery.error && <p role="status">장부 정보 확인 중…</p>}
      {/* 상단: 테두리 없는 순자산 스트립 (D6) */}
      <div className="strip">
        <div className="cell">
          <span className="metric-label" aria-hidden="true">순자산 (오늘)</span>
          <h1 className="hero" aria-label={`대시보드, 오늘 순자산 ${balances ? fmtWon(balances.net_worth) : "확인 중"}`}>
            {balances ? fmtWon(balances.net_worth) : "…"}
          </h1>
        </div>
        <div className="cell">
          <span className="metric-label">이번 달 수입</span>
          <div className="v num">{supportQuery.data ? fmtWon(income) : "…"}</div>
        </div>
        <div className="cell">
          <span className="metric-label">이번 달 지출</span>
          <div className="v num">{supportQuery.data ? fmtWon(expense) : "…"}</div>
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
      <div>
        {projectionQuery.error && <p role="alert">전망을 불러오지 못했습니다. {projectionQuery.error} <button className="btn secondary" onClick={projectionQuery.reload}>다시 계산</button></p>}
        {!projectionQuery.data && !projectionQuery.error && <p role="status">전망 계산 중…</p>}
        {projectionQuery.data && series?.length === 0 && <p>표시할 전망이 없습니다.</p>}
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
                    <button className="retry-action" type="button" onClick={balancesQuery.reload}>다시 시도</button>
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
              {supportQuery.data && topExpense.length === 0 && (
                <tr><td colSpan={2} style={{ color: "var(--muted)" }}>이번 달 지출 기록이 없습니다</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
