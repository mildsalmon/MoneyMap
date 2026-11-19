import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import type { Statistics as StatisticsData } from "../api/statistics";
import type { ViewProps } from "../App";
import { fmtAbbrev, fmtWon } from "../format";
import { useQuery } from "./scenarios/useQuery";
import { readStatisticsPeriod, statisticsPeriodError, statisticsPreset, statisticsSearch, statisticsToday, type StatisticsPeriod, type StatisticsPreset } from "./statisticsQuery";
import { groupStatistics } from "./statisticsGroups";
import "./statistics.css";


function AccountTable({ data, kind, title }: { data: StatisticsData; kind: "income" | "expense" | "asset" | "liability"; title: string }) {
  const groups = groupStatistics(data, kind);
  return <section><h2>{title}</h2><table className="ledger" aria-label={title}>
    <thead><tr><th>계정 · 현재 경로</th><th className="num">원</th></tr></thead>
    {groups.map(group => <tbody key={group.id}>
      {group.name !== null && <tr className="balance-group"><th colSpan={2} scope="rowgroup">{group.name}</th></tr>}
      {group.items.map(item => <tr key={item.id}><td className="statistics-account">{item.label}
        {item.archived && <span className="badge">보관</span>}</td><td className="num">{fmtWon(item.value)}</td></tr>)}
      {group.name !== null && <tr className="statistics-subtotal"><th scope="row">{group.name} 소계</th><td className="num">{fmtWon(group.total)}</td></tr>}
    </tbody>)}
    {!groups.length && <tbody><tr><td colSpan={2}>표시할 {kind === "income" || kind === "expense" ? "기간 기록" : "기간말 잔액"}이 없습니다.</td></tr></tbody>}
    <tfoot><tr className="sum"><th scope="row">합계</th><td className="num">{fmtWon(groups.reduce((sum, g) => sum + g.total, 0n))}</td></tr></tfoot>
  </table></section>;
}

function MonthlyFlow({ rows }: { rows: StatisticsData["monthly"] }) {
  const values = rows.flatMap(row => [row.income, row.expense]);
  const max = Math.max(1, ...values), min = Math.min(0, ...values);
  const width = Math.max(680, rows.length * 64 + 72), height = 220;
  const y = (n: number) => 16 + (max - n) / (max - min) * 162;
  const group = (width - 72) / Math.max(1, rows.length), zero = y(0);
  return <div className="statistics-monthly">
    <p className="muted">채운 막대는 수입, 테두리 막대는 지출입니다. 정확한 금액은 아래 표에서 확인할 수 있습니다.</p>
    <div className="table-scroll" aria-hidden="true"><svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", maxWidth: "none" }}>
      {[...new Set([max, 0, min])].map(value => <g key={value}><line x1={62} x2={width} y1={y(value)} y2={y(value)} stroke="var(--line)" />
        <text x={54} y={y(value) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">{fmtAbbrev(value)}</text></g>)}
      {rows.map((row, index) => <g key={row.month}>
        {[row.income, row.expense].map((value, i) => <rect key={i} x={68 + index * group + i * 17} y={Math.min(zero, y(value))}
          width={12} height={Math.abs(y(value) - zero)} fill={i === 0 ? "var(--accent)" : "none"} stroke={i === 0 ? "var(--accent)" : "var(--ink)"} />)}
        <text x={84 + index * group} y={204} textAnchor="middle" fontSize={11} fill="var(--muted)">{row.month}</text>
      </g>)}
    </svg></div>
    <div className="table-scroll" tabIndex={0} role="region" aria-label="월별 통계 표"><table className="ledger statistics-month-table">
      <caption>월별 수입·지출과 순자산</caption><thead><tr><th>월 · 조회 종료일</th><th className="num">수입</th><th className="num">지출</th><th className="num">수지</th><th className="num">자본 변동</th><th className="num">순자산</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.month}><th scope="row">{row.month}<small>{row.through} 기준</small></th>
        {[row.income, row.expense, row.net_income, row.capital_change, row.net_worth].map((value, i) => <td key={i} className="num">{fmtWon(value)}</td>)}
      </tr>)}</tbody></table></div>
  </div>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><dt>{label}</dt><dd className="num">{fmtWon(value)}</dd></div>;
}

export function Statistics({ gen }: ViewProps) {
  const location = useLocation(), navigate = useNavigate();
  const parsed = useMemo(() => readStatisticsPeriod(location.search), [location.search]);
  const [draft, setDraft] = useState<StatisticsPeriod>(parsed.draft);
  const [formError, setFormError] = useState<string>();
  const results = useRef<HTMLHeadingElement>(null), focusNext = useRef(false);
  const key = parsed.query ? statisticsSearch(parsed.query) : "invalid";
  const query = useQuery(`statistics:${key}:${gen}`, signal => parsed.query
    ? api.statistics(parsed.query.start, parsed.query.end, signal) : Promise.resolve(null));
  const data = query.data;
  useEffect(() => { setDraft(parsed.draft); setFormError(undefined); }, [location.search]); // URL/back restores the applied criteria.
  useEffect(() => {
    if (parsed.query && location.search !== statisticsSearch(parsed.query)) {
      navigate({ search: statisticsSearch(parsed.query) }, { replace: true });
    }
  }, [key, location.search, navigate]);
  useEffect(() => { if (data && focusNext.current) { focusNext.current = false; results.current?.focus(); } }, [data]);
  const apply = (period: StatisticsPeriod) => {
    const error = statisticsPeriodError(period); setFormError(error);
    if (error) return;
    setDraft(period); focusNext.current = true;
    const search = statisticsSearch(period);
    if (search === location.search) query.reload(); else navigate({ search });
  };
  const dirty = !!parsed.query && statisticsSearch(draft) !== key;
  const presets: [StatisticsPreset, string][] = [["this-month", "이번 달"], ["last-month", "지난달"], ["this-year", "올해"], ["recent-year", "최근 12개월"]];
  return <div className="statistics-page"><h1>통계</h1>
    <p className="muted">기록된 원화 장부의 수익·비용과 자산 변화를 확인합니다. 투자손익도 포함한 전체 계정 집계입니다.</p>
    <form className="statistics-query" onSubmit={e => { e.preventDefault(); apply(draft); }} aria-label="통계 조회 조건">
      <div className="filters">{presets.map(([preset, label]) => <button type="button" className="btn secondary" key={preset} onClick={() => apply(statisticsPreset(preset))}>{label}</button>)}</div>
      <div className="statistics-dates">
        <div className="field"><label htmlFor="statistics-start">시작일</label><input id="statistics-start" type="date" required value={draft.start} max={statisticsToday()} onChange={e => setDraft({ ...draft, start: e.target.value })} /></div>
        <div className="field"><label htmlFor="statistics-end">종료일</label><input id="statistics-end" type="date" required value={draft.end} max={statisticsToday()} onChange={e => setDraft({ ...draft, end: e.target.value })} /></div>
        <button className="btn primary" type="submit">조회</button>
      </div>
      {(formError || parsed.error) && <p role="alert">{formError ?? parsed.error}</p>}
      {dirty && <p role="status">조회 버튼을 눌러 적용하세요. 아래는 이전 조건의 결과입니다.</p>}
    </form>
    <section aria-busy={!!parsed.query && !data && !query.error} aria-label="통계 결과">
      {parsed.query && !data && !query.error && <p role="status">통계를 계산하고 있습니다…</p>}
      {query.error && <div role="alert"><p>통계를 불러오지 못했습니다. {query.error}</p>
        <p>재시도할 기간: {parsed.query?.start} ~ {parsed.query?.end}</p><button className="btn secondary" onClick={query.reload}>다시 조회</button></div>}
      {data && <>
        <h2 ref={results} tabIndex={-1} className="statistics-result-title">{data.start} ~ {data.end} · {data.transaction_count.toLocaleString("ko-KR")}건</h2>
        <p className="muted">서울 기준 {data.as_of}까지 · KRW만 집계 · 보관 계정 포함 · 현재 계정 계층 기준</p>
        {data.excluded_transaction_count > 0 && <p className="banner info" role="status">종료일까지 비원화 계정·분개가 포함된 거래 {data.excluded_transaction_count}건 전체를 제외했습니다. 기간 전 잔액에 영향을 주는 거래도 포함한 건수입니다.</p>}
        {data.summary.reconciliation_difference !== 0 && <p role="alert">원장 검산 차이: {fmtWon(data.summary.reconciliation_difference)}. 장부 기록을 확인하세요.</p>}
        <h2>기간 수입과 지출</h2><dl className="statistics-summary" aria-label="기간 수입과 지출">
          <Metric label="수입" value={data.summary.income} /><Metric label="지출" value={data.summary.expense} /><Metric label="수지 · 수입 − 지출" value={data.summary.net_income} />
        </dl>
        <h2>기간말 자산과 변화</h2><dl className="statistics-summary" aria-label="기간말 자산과 변화">
          <Metric label="자산" value={data.summary.assets} /><Metric label="부채" value={data.summary.liabilities} /><Metric label="순자산" value={data.summary.net_worth} />
          <Metric label="조회 시작 직전 순자산" value={data.summary.opening_net_worth} /><Metric label="기간 순자산 변화" value={data.summary.net_worth_change} /><Metric label="자본 변동 · 개시잔액 등" value={data.summary.capital_change} />
        </dl><p className="muted">순자산 변화 = 수입 − 지출 + 자본 변동. 수지는 저축액이나 통장 현금 흐름과 다를 수 있습니다.</p>
        {!data.transaction_count && <p role="status">이 기간의 원화 거래 기록이 없습니다. 이전 기록의 기간말 잔액은 유지됩니다.</p>}
        <h2>월별 추이</h2><MonthlyFlow rows={data.monthly} />
        <div className="statistics-tables"><AccountTable data={data} kind="income" title="기간 수입 구성" /><AccountTable data={data} kind="expense" title="기간 지출 구성" />
          <AccountTable data={data} kind="asset" title="기간말 자산 구성" /><AccountTable data={data} kind="liability" title="기간말 부채 구성" /></div>
        <p className="muted">계정 구성은 직접 기록을 한 번씩 합산합니다. 마이너스통장은 음수 잔액을 부채 구성에 표시하며, 자산·부채 구성은 기간말 0원이 아닌 계정을 보여줍니다.</p>
      </>}
    </section>
  </div>;
}
