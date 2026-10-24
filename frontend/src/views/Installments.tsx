import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, accountTree, isPostable, type Account } from "../api";
import { req } from "../api/core";
import type { InstallmentPlan } from "../api/installments";
import type { ViewProps } from "../App";
import { fmtWon, todayIso } from "../format";
import { useQuery } from "./scenarios/useQuery";
import "./installments.css";

const PENDING_KEY = "moneymap.installment.pending";
type Pending = {path: string; method: string; body: Record<string, unknown>};
function recover(): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
    return value && typeof value.path === "string" && /^\/installments(?:\/(?:allocations|rows\/\d+|\d+))?$/.test(value.path)
      && ["POST", "PUT", "DELETE"].includes(value.method) && typeof value.body?.request_id === "string"
      && Number.isSafeInteger(value.body?.expected_revision) ? value : null;
  } catch { return null; }
}
const newDraft = () => ({description: "", date: todayIso(), debit_account_id: "", card_account_id: "", cash_account_id: "", principal: "", months: "6", first_due_date: todayIso(), exclude_from_spend: false});

export function Installments({gen, refresh, showToast}: ViewProps) {
  const query = useQuery(`installments:${gen}`, signal => Promise.all([api.installments(signal), api.accounts(signal)]));
  const data = query.data?.[0];
  const accounts = query.data?.[1] ?? [];
  const plans = data?.plans ?? [];
  const [draft, setDraft] = useState(newDraft);
  const [preview, setPreview] = useState<{number: number; due_date: string; principal: number}[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(recover);
  const inFlight = useRef(false);
  const [search, setSearch] = useState("");
  const candidates = useQuery(`installment-transactions:${search}:${gen}`, signal => api.installmentCandidates(search, signal));
  const [transactionId, setTransactionId] = useState("");
  const [kind, setKind] = useState<"payment" | "refund">("payment");
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const loadedAllocation = useRef("");
  const [dates, setDates] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const locked = busy || pending !== null;
  const name = (id: number) => accounts.find(a => a.id === id)?.name ?? `#${id}`;

  useEffect(() => {
    if (!data || loadedAllocation.current === transactionId) return;
    loadedAllocation.current = transactionId;
    const existing = data.plans.flatMap(p => p.allocations).filter(a => a.transaction_id === Number(transactionId));
    setAmounts(Object.fromEntries(existing.map(a => [a.installment_id, String(a.amount)])));
    setKind(existing[0]?.kind ?? "payment");
  }, [transactionId, data]);

  const execute = async (command: Pending) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    // Keep the exact command through network loss and page reload. Replaying it
    // returns the server receipt and can never create a second purchase.
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(command));
      setPending(command);
      const result = await req<{revision?: number; request_id?: string; id?: number; purchase_id?: number; transaction_id?: number} | null>(command.path, {method: command.method, body: JSON.stringify(command.body), signal: AbortSignal.timeout(15_000)});
      if (!result || !Number.isSafeInteger(result.revision) || result.revision! <= 0 || result.request_id !== command.body.request_id
        || (command.path === "/installments" && (!Number.isSafeInteger(result.id) || result.id! <= 0 || !Number.isSafeInteger(result.purchase_id) || result.purchase_id! <= 0))
        || (command.path === "/installments/allocations" && result.transaction_id !== command.body.transaction_id)) {
        throw new Error("저장 응답을 확인할 수 없습니다. 같은 요청으로 결과를 다시 확인하세요");
      }
      sessionStorage.removeItem(PENDING_KEY); setPending(null);
      if (command.path === "/installments" && command.method === "POST") { setDraft(newDraft()); setPreview(null); }
      setDates({});
      loadedAllocation.current = "";
      refresh(); showToast("할부 내역을 저장했습니다");
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        sessionStorage.removeItem(PENDING_KEY); setPending(null);
        if (e.status === 409) refresh();
      }
      setError((e as Error).message);
    } finally { setBusy(false); inFlight.current = false; }
  };
  const save = (path: string, method: string, body: Record<string, unknown>) => {
    if (!data || locked) return;
    void execute({path, method, body: {...body, request_id: crypto.randomUUID(), expected_revision: data.revision}});
  };
  const purchase = () => ({...draft, principal: Number(draft.principal), months: Number(draft.months), debit_account_id: Number(draft.debit_account_id), card_account_id: Number(draft.card_account_id), cash_account_id: Number(draft.cash_account_id)});
  const previewPurchase = async () => {
    if (!data || locked) return;
    setBusy(true); setError("");
    try {
      const result = await req<{installments: NonNullable<typeof preview>}>("/installments/preview", {method: "POST", body: JSON.stringify({...purchase(), request_id: crypto.randomUUID(), expected_revision: data.revision}), signal: AbortSignal.timeout(15_000)});
      setPreview(result.installments);
    } catch (e) { setError((e as Error).message); } finally {setBusy(false);}
  };
  const field = (key: keyof typeof draft, value: string | boolean) => {setDraft({...draft, [key]: value}); setPreview(null);};
  const accountSelect = (key: "debit_account_id" | "card_account_id" | "cash_account_id", label: string, filter: (a: Account) => boolean) => (
    <label>{label}<select required value={draft[key]} onChange={e => field(key, e.target.value)}>
      <option value="">선택</option>{accountTree(accounts).filter(row => !row.account.archived && !row.account.is_system && row.account.currency === "KRW" && isPostable(accounts, row.account) && filter(row.account)).map(row => <option key={row.account.id} value={row.account.id}>{"　".repeat(row.depth)}{row.account.name}</option>)}
    </select></label>
  );
  const setMode = (p: InstallmentPlan, mode: string) => save(`/installments/${p.id}`, "PUT", {projection_mode: mode, rule_signature: p.current_rule_signature});
  const thisMonth = data?.as_of.slice(0, 7);
  const monthly = plans.flatMap(p => p.installments).filter(r => r.due_date.startsWith(thisMonth ?? "!")).reduce((sum, r) => sum + r.remaining, 0);

  return <section className="installment-page">
    <h1>할부 관리</h1>
    <p className="m">원화 무이자 할부입니다. 구매는 총액으로 기록하고, 납부는 실제 거래를 연결해 확인합니다. 예정일이 지나도 자동으로 납부 처리하지 않습니다.</p>
    {query.error && <p role="alert">{query.error} <button className="btn" onClick={query.reload}>다시 불러오기</button></p>}
    {!data && !query.error && <p role="status">할부 내역 확인 중…</p>}
    {error && <p role="alert">{error}</p>}
    {pending && <div className="banner info" role="status">저장 결과를 확인해야 합니다. 같은 요청으로 확인하면 중복 저장되지 않습니다. <button className="btn" disabled={busy} onClick={() => void execute(pending)}>저장 결과 다시 확인</button></div>}
    {data && <>
      <div className="installment-summary"><span>남은 원금 <strong>{fmtWon(plans.reduce((sum, p) => sum + p.remaining_principal, 0))}</strong></span><span>이번 달 미확인 납부 예정 <strong>{fmtWon(monthly)}</strong></span></div>
      <p className="m">할부 원금만 표시합니다. 전체 카드 청구액과는 다릅니다.</p>
      <details className="panel">
        <summary>새 할부 구매</summary>
        <form onSubmit={e => {e.preventDefault(); void previewPurchase();}}>
          <fieldset disabled={locked} className="installment-form">
            <label>구매 내역<input required maxLength={2000} value={draft.description} onChange={e => field("description", e.target.value)} /></label>
            <label>구매일<input type="date" required max={todayIso()} value={draft.date} onChange={e => field("date", e.target.value)} /></label>
            {accountSelect("debit_account_id", "구매 계정 (비용·자산)", a => a.type === "expense" || a.type === "asset")}
            {accountSelect("card_account_id", "카드 계정 (부채)", a => a.type === "liability")}
            {accountSelect("cash_account_id", "납부 통장", a => a.type === "asset")}
            <label>구매 총액 (원)<input type="number" required min="2" max="9007199254740991" step="1" value={draft.principal} onChange={e => field("principal", e.target.value)} /></label>
            <label>할부 개월 수<input type="number" required min="2" max="60" step="1" value={draft.months} onChange={e => field("months", e.target.value)} /></label>
            <label>첫 납부 예정일<input type="date" required min={draft.date} value={draft.first_due_date} onChange={e => field("first_due_date", e.target.value)} /></label>
            <label className="installment-wide"><input type="checkbox" checked={draft.exclude_from_spend} onChange={e => field("exclude_from_spend", e.target.checked)} /> 일회성 구매로 지정 (기존 시나리오의 반복 소비 추정에서만 제외, 소비 통계는 유지)</label>
            <button className="btn secondary" type="submit">회차 미리보기</button>
          </fieldset>
        </form>
        {preview && <div>
          <p>구매 거래 {fmtWon(Number(draft.principal))}와 아래 납부 일정을 함께 저장합니다.</p>
          <div className="table-scroll"><table className="ledger"><thead><tr><th>회차</th><th>예정일</th><th className="num">원금</th></tr></thead><tbody>{preview.map(r => <tr key={r.number}><td>{r.number}회</td><td>{r.due_date}</td><td className="num">{fmtWon(r.principal)}</td></tr>)}</tbody></table></div>
          <button className="btn primary" disabled={locked} onClick={() => save("/installments", "POST", purchase())}>구매·할부 일정 저장</button>
        </div>}
      </details>
      <h2>할부 목록</h2>
      {plans.length === 0 && <p>등록한 할부가 없습니다. 새 할부 구매에서 시작하세요.</p>}
      {plans.map(p => <section key={p.id} className="installment-plan">
        <div className="installment-heading"><h3>{p.description}</h3><button className="btn secondary" onClick={() => setExpanded(expanded === p.id ? null : p.id)} aria-expanded={expanded === p.id}>회차·납부 보기</button></div>
        <p>{p.purchase_date} · {name(p.card_account_id)} → 납부 통장 {name(p.cash_account_id)} · <Link to={`/transactions/${p.purchase_id}/edit`}>구매 거래 #{p.purchase_id}</Link></p>
        <p>구매 총액 {fmtWon(p.principal)} · 남은 원금 <strong>{fmtWon(p.remaining_principal)}</strong> · 다음 예정일 {p.next_due_date ?? "완료"} · 완납 예정 {p.completion_date?.slice(0,7) ?? "완료"}</p>
        {p.installments.some(r => r.status === "needs_confirmation") && <p className="banner info">지난 예정일 중 납부 확인이 필요한 회차가 있습니다. 실제 거래를 연결하거나 예정일을 조정하세요. 해당 금액은 미래 현금 전망에 포함되지 않습니다.</p>}
        {p.needs_projection_decision && <p className="banner info">카드값 반복 규칙과 중복 여부를 확인하세요. 확인 전에는 할부 예정액을 전망에 별도로 더하지 않습니다.</p>}
        {p.conflicting_rules.length > 0 && <p>겹칠 수 있는 규칙: {p.conflicting_rules.map(r => `${r.description || `규칙 #${r.id}`} (${fmtWon(r.amount)})`).join(", ")}</p>}
        {(p.conflicting_rules.length > 0 || p.needs_projection_decision) && <div className="installment-actions">
          <button className="btn secondary" disabled={locked} onClick={() => setMode(p, "separate")}>규칙에 미포함 — 할부 별도 반영</button>
          {p.conflicting_rules.length > 0 && <button className="btn secondary" disabled={locked} onClick={() => setMode(p, "included")}>규칙에 포함 — 중복 반영 안 함</button>}
        </div>}
        {!accounts.find(a => a.id === p.cash_account_id)?.include_in_cash && p.remaining_principal > 0 && <p className="m">납부 통장이 현금 전망 계정에 포함되어 있지 않습니다. <Link to="/accounts">계정 설정</Link>에서 포함 여부를 선택하세요.</p>}
        {!p.needs_projection_decision && <p className="m">전망: {p.projection_mode === "included" ? "카드값 반복 규칙에 포함" : "미납 회차 원금 별도 반영"}</p>}
        {expanded === p.id && <>
          <div className="table-scroll"><table className="ledger"><thead><tr><th>회차</th><th>납부 예정일</th><th className="num">원금</th><th className="num">남은 원금</th><th>상태</th></tr></thead><tbody>{p.installments.map(r => <tr key={r.id}>
            <td>{r.number}회</td><td><input aria-label={`${p.description} ${r.number}회 예정일`} type="date" min={p.purchase_date} value={dates[r.id] ?? r.due_date} disabled={locked || r.settled > 0} onChange={e => setDates({...dates, [r.id]: e.target.value})} />{dates[r.id] && dates[r.id] !== r.due_date && <button className="btn sm secondary" disabled={locked || !dates[r.id]} onClick={() => save(`/installments/rows/${r.id}`, "PUT", {due_date: dates[r.id]})}>날짜 저장</button>}</td>
            <td className="num">{fmtWon(r.principal)}</td><td className="num">{fmtWon(r.remaining)}</td><td>{r.status === "paid" ? "납부·환불 확인" : r.status === "needs_confirmation" ? "확인 필요" : "예정"}</td>
          </tr>)}</tbody></table></div>
          {p.allocations.length > 0 && <ul>{p.allocations.map(a => <li key={`${a.transaction_id}-${a.installment_id}`}>{a.date} {a.kind === "refund" ? "환불" : "납부"} {fmtWon(a.amount)} · 거래 #{a.transaction_id} {a.description}</li>)}</ul>}
          <button className="btn secondary" disabled={locked || p.allocations.length > 0} onClick={() => {if (window.confirm("할부 일정만 삭제합니다. 구매 거래는 원장에 남습니다.")) save(`/installments/${p.id}`, "DELETE", {});}}>일정 삭제 (구매 거래 유지)</button>
        </>}
      </section>)}
      {plans.length > 0 && <section className="panel">
        <h2>실제 납부·환불 연결</h2>
        <p>먼저 <Link to="/transactions/new">거래 입력</Link>에서 실제 납부를 통장→카드로 기록하세요. 합산 납부·중도상환은 한 거래를 여러 회차에 나누어 연결합니다. 환불은 구매 계정→카드 거래를 연결합니다.</p>
        <fieldset disabled={locked} className="installment-form">
          <label>거래 검색 (내역 또는 거래 번호)<input value={search} onChange={e => {setSearch(e.target.value); setTransactionId("");}} /></label>
          <label>실제 거래<select value={transactionId} onChange={e => setTransactionId(e.target.value)}><option value="">거래 선택</option>{candidates.data?.map(t => <option key={t.id} value={t.id}>#{t.id} {t.date} {t.description} · {fmtWon(t.postings.filter(p => p.amount > 0).reduce((s,p) => s+p.amount,0))}</option>)}</select></label>
          <label>연결 종류<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="payment">납부·중도상환</option><option value="refund">구매 환불</option></select></label>
        </fieldset>
        {candidates.error && <p role="alert">거래 조회 실패: {candidates.error} <button className="btn" onClick={candidates.reload}>다시 조회</button></p>}
        <p className="m">최근 100건을 표시합니다. 이전 거래는 내역 또는 거래 번호로 검색하세요. 연결은 원장에 출금을 추가하지 않습니다.</p>
        {transactionId && <>
          <div className="table-scroll"><table className="ledger"><thead><tr><th>구매·회차</th><th>예정일</th><th className="num">원금</th><th className="num">이 거래의 배분액 (원)</th></tr></thead><tbody>{plans.flatMap(p => p.installments.filter(r => r.remaining > 0 || p.allocations.some(a => a.installment_id === r.id && a.transaction_id === Number(transactionId))).map(r => <tr key={r.id}><td>{p.description} {r.number}회</td><td>{r.due_date}</td><td className="num">{fmtWon(r.principal)}</td><td className="num"><input aria-label={`${p.description} ${r.number}회 배분액`} type="number" min="0" step="1" max={r.principal} value={amounts[r.id] ?? ""} disabled={locked} onChange={e => setAmounts({...amounts, [r.id]: e.target.value})} /></td></tr>))}</tbody></table></div>
          <p>배분 합계 {fmtWon(Object.values(amounts).reduce((sum, value) => sum + Number(value || 0), 0))}</p>
          <button className="btn primary" disabled={locked} onClick={() => save("/installments/allocations", "PUT", {transaction_id: Number(transactionId), kind, allocations: Object.entries(amounts).filter(([,v]) => Number(v) !== 0).map(([id, value]) => ({installment_id: Number(id), amount: Number(value)}))})}>배분 저장</button>{" "}
          <button className="btn secondary" disabled={locked} onClick={() => {if(window.confirm("선택한 거래의 모든 할부 배분을 해제합니다. 실제 거래는 유지됩니다.")) save("/installments/allocations", "PUT", {transaction_id: Number(transactionId), kind, allocations: []});}}>이 거래의 배분 모두 해제</button>
        </>}
      </section>}
    </>}
  </section>;
}
