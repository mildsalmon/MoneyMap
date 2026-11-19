import { Fragment, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import type { ComparisonPeriod, FlowComparison, Statistics, StatisticsComparison } from "../api/statistics";
import { fmtMoney, fmtWon } from "../format";
import { useQuery } from "./scenarios/useQuery";
import { statisticsSearch, type StatisticsSelection } from "./statisticsQuery";

function range(period: ComparisonPeriod) {
  return `${period.start} ~ ${period.end} (${period.days}일)`;
}

// Round once, to tenths of a percent, even when the difference exceeds the
// safe integer range of either individual KRW amount.
function changeRate(delta: bigint, previous: number) {
  if (previous === 0) return "산출 불가";
  const denominator = BigInt(Math.abs(previous));
  const magnitude = delta < 0n ? -delta : delta;
  const tenths = (magnitude * 1000n + denominator / 2n) / denominator;
  const fraction = tenths % 10n;
  return `${delta < 0n && tenths ? "−" : ""}${(tenths / 10n).toLocaleString("ko-KR")}${fraction ? `.${fraction}` : ""}%`;
}

function TransactionLines({ id, data, comparison }: { id: number; data: Statistics; comparison: StatisticsComparison }) {
  const txn = useQuery(String(id), signal => api.transaction(id, signal));
  if (txn.error) return <p role="alert">{txn.error} <button onClick={txn.reload}>다시 조회</button></p>;
  if (!txn.data) return <p role="status">분개 조회 중…</p>;
  return <div><p>{txn.data.tags.map(tag => `#${tag}`).join(" ")} {txn.data.memo}</p>
    <table className="ledger" aria-label="원본 거래 분개"><thead><tr><th>계정</th><th>생활 분류</th><th className="num">분개 금액</th></tr></thead>
      <tbody>{txn.data.postings.map(p => {
        const account = data.accounts.find(a => a.id === p.account_id);
        const category = comparison.categories.find(c => c.id === p.category_id);
        return <tr key={p.posting_id}><td>{account?.name ?? `#${p.account_id}`}</td>
          <td>{category?.name ?? (account?.type === "income" || account?.type === "expense" ? "미분류" : "—")}</td>
          <td className="num">{fmtMoney(p.amount, p.currency)}</td></tr>;
      })}</tbody></table></div>;
}

function TransactionList({ selection, data, comparison }: ComparisonProps) {
  const [expanded, setExpanded] = useState<number>();
  const items = comparison.details?.items ?? [];
  const page = Number(selection.page ?? 1);
  const period = selection.detail === "previous" ? comparison.previous : comparison.current;
  const tag = comparison.tags.find(t => String(t.tag_id) === selection.tag_id);
  const category = comparison.categories.find(c => String(c.id) === selection.category_id);
  return <section className="statistics-details"><h2>거래 상세</h2>
    <p>{selection.detail === "previous" ? "전기" : "조회 기간"} · {period ? range(period) : "비교 기간 없음"} · {tag?.name ?? "전체 태그"} · {category?.name ?? (selection.category_id ? "미분류" : "전체 분류")}</p>
    <Link to={statisticsSearch({ ...selection, detail: undefined, page: undefined })}>비교 통계로 돌아가기</Link>
    {items.length ? <table className="ledger" aria-label="비교에 포함된 거래"><thead><tr><th>날짜 · 거래</th><th className="num">수입</th><th className="num">지출</th></tr></thead>
      <tbody>{items.map(tx => <Fragment key={tx.id}><tr><td>{tx.date}<br />
        <button className="btn secondary sm" aria-expanded={expanded === tx.id} onClick={() => setExpanded(expanded === tx.id ? undefined : tx.id)}>{tx.description || `거래 #${tx.id}`}</button></td>
        <td className="num">{fmtWon(tx.income)}</td><td className="num">{fmtWon(tx.expense)}</td></tr>
        {expanded === tx.id && <tr><td colSpan={3}><TransactionLines id={tx.id} data={data} comparison={comparison} /></td></tr>}</Fragment>)}</tbody></table>
      : <p>이 조건에 해당하는 거래가 없습니다.</p>}
    {(page > 1 || comparison.details?.has_more) && <nav aria-label="상세 거래 페이지">
      {page > 1 && <Link to={statisticsSearch({ ...selection, page: String(page - 1) })}>이전 페이지</Link>} {page}쪽{" "}
      {comparison.details?.has_more && <Link to={statisticsSearch({ ...selection, page: String(page + 1) })}>다음 페이지</Link>}</nav>}
  </section>;
}

interface ComparisonProps { data: Statistics; comparison: StatisticsComparison; selection: StatisticsSelection }

export function Comparison(props: ComparisonProps) {
  const { comparison, selection } = props;
  const navigate = useNavigate();
  const { category_id, tag_id } = selection;
  const select = (change: Partial<StatisticsSelection>) => navigate({ search: statisticsSearch({ ...selection, ...change }) });
  if (selection.detail) return <TransactionList key={statisticsSearch(selection)} {...props} />;
  const buckets: [string, string | undefined, FlowComparison][] = [];
  if (!tag_id) buckets.push(["전체", undefined, comparison.overall]);
  for (const tag of comparison.tags) {
    if (!tag_id || Number(tag_id) === tag.tag_id) buckets.push([tag.name, String(tag.tag_id), tag]);
  }
  return <section className="statistics-comparison"><h2>기간·태그 비교</h2>
    <p>조회 기간 {range(comparison.current)}<br />전기 {comparison.previous ? range(comparison.previous) : "조회 가능한 이전 기간이 없습니다."}</p>
    <div className="filters"><label>비교할 생활 분류 <select value={category_id ?? ""} onChange={e => select({ category_id: e.target.value || undefined, tag_id: undefined })}>
      <option value="">전체 분류</option>{comparison.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}<option value="unclassified">미분류</option></select></label>
      <label>비교할 태그 <select value={tag_id ?? ""} onChange={e => select({ tag_id: e.target.value || undefined })}>
        <option value="">전체 태그</option>{comparison.tags.map(t => <option key={t.tag_id} value={t.tag_id}>{t.name}</option>)}</select></label></div>
    <p className="muted">태그가 여러 개인 거래는 각 태그에 한 번씩 포함됩니다. 전체는 각 분개를 한 번만 합산합니다. 금액을 선택하면 해당 거래를 볼 수 있습니다.</p>
    <div className="table-scroll" role="region" aria-label="기간 비교 표" tabIndex={0}><table className="ledger" aria-label="태그별 기간 비교">
      <thead><tr><th>태그</th><th>항목</th><th className="num">조회 기간</th><th className="num">전기</th><th className="num">증감액</th><th className="num">증감률</th></tr></thead>
      {buckets.map(([label, id, flow]) => <tbody key={id ?? "overall"}>{(["income", "expense"] as const).map(metric => {
        const current = flow.current[metric], previous = flow.previous[metric];
        const delta = BigInt(current) - BigInt(previous);
        const metricName = metric === "income" ? "수입" : "지출";
        const amountLink = (side: "current" | "previous", amount: number) => <Link aria-label={`${label} ${metricName} ${side === "current" ? "조회 기간" : "전기"} 거래 ${fmtWon(amount)}`}
          to={statisticsSearch({ ...selection, tag_id: id, detail: side })}>{fmtWon(amount)}</Link>;
        return <tr key={metric}><th scope="row">{label}</th><td>{metricName}</td><td className="num">{amountLink("current", current)}</td>
          <td className="num">{comparison.previous ? amountLink("previous", previous) : "—"}</td>
          <td className="num">{comparison.previous ? fmtWon(delta) : "—"}</td>
          <td className="num">{changeRate(delta, previous)}</td></tr>;
      })}</tbody>)}</table></div>
    <p className="muted">증감률은 증감액을 전기 금액의 절댓값으로 나눕니다. 전기가 0원이면 증감액만 표시합니다.</p>
  </section>;
}
