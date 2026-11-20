import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, accountTree, isPostable, type Account } from "../api";
import { req } from "../api/core";
import { StatementRows, EditStatement, optionalWon, type StatementDraft } from "./InstallmentStatement";
import type { Allocation, InstallmentPlan } from "../api/installments";
import type { ViewProps } from "../App";
import { fmtWon, todayIso } from "../format";
import { useQuery } from "./scenarios/useQuery";
import "./installments.css";

const PENDING_KEY = "moneymap.installment.pending";
type Pending = {path: string; method: string; body: Record<string, unknown>};
function recover(): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
    return value && typeof value.path === "string" && /^\/installments(?:\/(?:allocations|rows\/\d+(?:\/statement)?|\d+))?$/.test(value.path)
      && ["POST", "PUT", "DELETE"].includes(value.method) && typeof value.body?.request_id === "string"
      && Number.isSafeInteger(value.body?.expected_revision) ? value : null;
  } catch { return null; }
}
const kindLabels = {
  payment: "납부·중도상환", refund: "구매 원금 환불", charge: "비용 선기장 (카드 청구)",
  billed_payment: "선기장 비용 납부", rebate: "납부한 비용 환급", charge_refund: "미납 청구 비용 환급",
};
type Split = {amount?: string; interest?: string; fee?: string; interest_charge_id?: string; fee_charge_id?: string};
const splitTotal = (s: Split) => Number(s.amount || 0) + Number(s.interest || 0) + Number(s.fee || 0);
const newDraft = () => ({description: "", date: todayIso(), debit_account_id: "", card_account_id: "", cash_account_id: "", principal: "", months: "6", first_due_date: todayIso(), exclude_from_spend: false, statement_date: todayIso(), interest_account_id: "", fee_account_id: ""});

export function Installments({gen, refresh, showToast}: ViewProps) {
  const query = useQuery(`installments:${gen}`, signal => Promise.all([api.installments(signal), api.accounts(signal)]));
  const data = query.data?.[0];
  const accounts = query.data?.[1] ?? [];
  const plans = data?.plans ?? [];
  const [draft, setDraft] = useState(newDraft);
  const [statementMode, setStatementMode] = useState(false);
  const [edits, setEdits] = useState<Record<number, Partial<StatementDraft>>>({});
  const months = Number(draft.months);
  const each = Math.floor(Number(draft.principal) / months);
  const rows: StatementDraft[] = Array.from({length: Math.min(60, Math.max(0, months))}, (_, i) => ({
    principal: String(i+1 === months ? Number(draft.principal) - each * i : each), interest: "", fee: "", ...edits[i],
  }));
  const dated = useQuery(`installment-accounts:${draft.date}:${gen}`, signal => api.datedAccounts(draft.date, signal));
  const [preview, setPreview] = useState<{number: number; due_date: string; principal: number; interest?: number | null; fee?: number | null}[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(recover);
  const inFlight = useRef(false);
  const [search, setSearch] = useState("");
  const candidates = useQuery(`installment-transactions:${search}:${gen}`, signal => api.installmentCandidates(search, signal));
  const [transactionId, setTransactionId] = useState("");
  const [kind, setKind] = useState<Allocation["kind"]>("payment");
  const [amounts, setAmounts] = useState<Record<number, Split>>({});
  const changeSplit = (id: number, key: keyof Split, value: string) =>
    setAmounts(prev => ({...prev, [id]: {...prev[id], [key]: value}}));
  const loadedAllocation = useRef("");
  const [dates, setDates] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const locked = busy || pending !== null;
  const name = (id: number) => accounts.find(a => a.id === id)?.name ?? `#${id}`;

  useEffect(() => {
    if (!data || loadedAllocation.current === transactionId) return;
    loadedAllocation.current = transactionId;
    const existing = data.plans.flatMap(p => p.allocations).filter(a => a.transaction_id === Number(transactionId));
    setAmounts(Object.fromEntries(existing.map(a => [a.installment_id, {amount: String(a.amount), interest: String(a.interest), fee: String(a.fee), interest_charge_id: String(a.interest_charge_id ?? ""), fee_charge_id: String(a.fee_charge_id ?? "")}])));
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
      if (command.path === "/installments" && command.method === "POST") { setDraft(newDraft()); setPreview(null); setStatementMode(false); setEdits({}); }
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
  const purchase = () => ({...draft, statement_date: statementMode ? draft.statement_date : null, interest_account_id: statementMode ? Number(draft.interest_account_id) : null,
    fee_account_id: statementMode ? Number(draft.fee_account_id) : null,
    statement: statementMode ? rows.map(r => ({principal: Number(r.principal), interest: optionalWon(r.interest), fee: optionalWon(r.fee)})) : null,
    principal: Number(draft.principal), months: Number(draft.months), debit_account_id: Number(draft.debit_account_id), card_account_id: Number(draft.card_account_id), cash_account_id: Number(draft.cash_account_id)});
  const previewPurchase = async () => {
    if (!data || locked || !accountsReady) return;
    if (statementMode && rows.reduce((n,r) => n + Number(r.principal), 0) !== Number(draft.principal)) {
      setError("회차 원금 합계가 구매 총액과 일치해야 합니다"); return;
    }
    setBusy(true); setError("");
    try {
      const result = await req<{installments: NonNullable<typeof preview>}>("/installments/preview", {method: "POST", body: JSON.stringify({...purchase(), request_id: crypto.randomUUID(), expected_revision: data.revision}), signal: AbortSignal.timeout(15_000)});
      setPreview(result.installments);
    } catch (e) { setError((e as Error).message); } finally {setBusy(false);}
  };
  const field = (key: keyof typeof draft, value: string | boolean) => {setDraft({...draft, [key]: value}); setPreview(null);};
  const currentAvailable = new Set(accounts.filter(a => !a.is_system && a.currency === "KRW" && isPostable(accounts,a)).map(a => a.id));
  const purchaseAccounts = dated.data ?? [];
  const onPurchaseDay = new Set(purchaseAccounts.filter(a => !a.is_system && a.currency === "KRW" && isPostable(purchaseAccounts,a)).map(a => a.id));
  const accountsReady = onPurchaseDay.has(Number(draft.debit_account_id)) && onPurchaseDay.has(Number(draft.card_account_id))
    && (!statementMode || (currentAvailable.has(Number(draft.interest_account_id)) && currentAvailable.has(Number(draft.fee_account_id)) && draft.interest_account_id !== draft.fee_account_id))
    && currentAvailable.has(Number(draft.card_account_id)) && currentAvailable.has(Number(draft.cash_account_id));
  const accountSelect = (key: "debit_account_id" | "card_account_id" | "cash_account_id" | "interest_account_id" | "fee_account_id", label: string, filter: (a: Account) => boolean) => (
    <label>{label}<select required value={draft[key]} onChange={e => field(key, e.target.value)}>
      <option value="">선택</option>{accountTree(key === "debit_account_id" || key === "card_account_id" ? purchaseAccounts : accounts).filter(({account}) => filter(account)
        && ((key !== "card_account_id" && key !== "debit_account_id") || onPurchaseDay.has(account.id))
        && (key === "debit_account_id" || currentAvailable.has(account.id))).map(row => <option key={row.account.id} value={row.account.id}>{"　".repeat(row.depth)}{row.account.name}</option>)}
    </select></label>
  );
  const setMode = (p: InstallmentPlan, mode: string) => save(`/installments/${p.id}`, "PUT", {projection_mode: mode, rule_signature: p.current_rule_signature});
  const thisMonth = data?.as_of.slice(0, 7);
  const monthly = plans.flatMap(p => p.installments).filter(r => r.due_date.startsWith(thisMonth ?? "!")).reduce((sum, r) => sum + r.unpaid_total, 0);

  return <section className="installment-page">
    <h1>할부 관리</h1>
    <p className="m">구매는 총액으로 기록하고, 납부는 실제 거래를 연결해 확인합니다. 예정일이 지나도 자동으로 납부 처리하지 않습니다.</p>
    {query.error && <p role="alert">{query.error} <button className="btn" onClick={query.reload}>다시 불러오기</button></p>}
    {!data && !query.error && <p role="status">할부 내역 확인 중…</p>}
    {error && <p role="alert">{error}</p>}
    {pending && <div className="banner info" role="status">저장 결과를 확인해야 합니다. 같은 요청으로 확인하면 중복 저장되지 않습니다. <button className="btn" disabled={busy} onClick={() => void execute(pending)}>저장 결과 다시 확인</button></div>}
    {data && <>
      <div className="installment-summary"><span>남은 원금 <strong>{fmtWon(plans.reduce((sum, p) => sum + p.remaining_principal, 0))}</strong></span><span>이번 달 미확인 납부 예정 <strong>{fmtWon(monthly)}</strong></span></div>
      <p className="m">납부 예정액에는 명세서에서 확인한 이자와 수수료가 포함됩니다.</p>
      <details className="panel">
        <summary>새 할부 구매</summary>
        <form onSubmit={e => {e.preventDefault(); void previewPurchase();}}>
          <fieldset disabled={locked} className="installment-form">
            <label>구매 내역<input required maxLength={2000} value={draft.description} onChange={e => field("description", e.target.value)} /></label>
            <label>구매일<input type="date" required max={todayIso()} value={draft.date} onChange={e => field("date", e.target.value)} /></label>
            {dated.error && <p role="alert">{dated.error} <button type="button" onClick={dated.reload}>계정 다시 조회</button></p>}
            {purchaseAccounts[0]?.history_known === false && <p>이력 미상 · 구매일이 수집 시작 전이라 현재 기장 가능한 계정을 표시합니다.</p>}
            {accountSelect("debit_account_id", "구매 계정 (비용·자산)", a => a.type === "expense" || a.type === "asset")}
            {accountSelect("card_account_id", "카드 계정 (부채)", a => a.type === "liability")}
            {accountSelect("cash_account_id", "납부 통장", a => a.type === "asset")}
            <label>구매 총액 (원)<input type="number" required min="2" max="9007199254740991" step="1" value={draft.principal} onChange={e => field("principal", e.target.value)} /></label>
            <label>할부 개월 수<input type="number" required min="2" max="60" step="1" value={draft.months} onChange={e => field("months", e.target.value)} /></label>
            <label>첫 납부 예정일<input type="date" required min={draft.date} value={draft.first_due_date} onChange={e => field("first_due_date", e.target.value)} /></label>
            <label className="installment-wide"><input type="checkbox" checked={statementMode} onChange={e => {setStatementMode(e.target.checked); setPreview(null);}} /> 유이자 할부 명세서 입력</label>
            {statementMode && <>
              <label>첫 명세서 기준일<input type="date" required min={draft.date} max={todayIso()} value={draft.statement_date} onChange={e => field("statement_date",e.target.value)}/></label>
              {accountSelect("interest_account_id", "이자 비용 계정", a => a.type === "expense")}
              {accountSelect("fee_account_id", "수수료 비용 계정", a => a.type === "expense")}
              <StatementRows rows={rows} change={(i,key,value) => {setEdits({...edits, [i]: {...edits[i], [key]: value}}); setPreview(null);}} />
            </>}
            <label className="installment-wide"><input type="checkbox" checked={draft.exclude_from_spend} onChange={e => field("exclude_from_spend", e.target.checked)} /> 일회성 구매로 지정 (기존 시나리오의 반복 소비 추정에서만 제외, 소비 통계는 유지)</label>
            <button className="btn secondary" type="submit" disabled={!accountsReady}>회차 미리보기</button>
          </fieldset>
        </form>
        {preview && <div>
          <p>구매 거래 {fmtWon(Number(draft.principal))}와 아래 납부 일정을 함께 저장합니다.</p>
          <div className="table-scroll"><table className="ledger"><thead><tr><th>회차</th><th>예정일</th><th className="num">원금</th>{statementMode && <><th>이자</th><th>수수료</th></>}</tr></thead><tbody>{preview.map(r => <tr key={r.number}><td>{r.number}회</td><td>{r.due_date}</td><td className="num">{fmtWon(r.principal)}</td>{statementMode && <><td>{r.interest == null ? "미확인" : fmtWon(r.interest)}</td><td>{r.fee == null ? "미확인" : fmtWon(r.fee)}</td></>}</tr>)}</tbody></table></div>
          <button className="btn primary" disabled={locked || !accountsReady} onClick={() => save("/installments", "POST", purchase())}>구매·할부 일정 저장</button>
        </div>}
      </details>
      <h2>할부 목록</h2>
      {plans.length === 0 && <p>등록한 할부가 없습니다. 새 할부 구매에서 시작하세요.</p>}
      {plans.map(p => <section key={p.id} className="installment-plan">
        <div className="installment-heading"><h3>{p.description}</h3><button className="btn secondary" onClick={() => setExpanded(expanded === p.id ? null : p.id)} aria-expanded={expanded === p.id}>회차·납부 보기</button></div>
        <p>{p.purchase_date} · {name(p.card_account_id)} → 납부 통장 {name(p.cash_account_id)} · <Link to={`/transactions/${p.purchase_id}/edit`}>구매 거래 #{p.purchase_id}</Link></p>
        <p>구매 총액 {fmtWon(p.principal)} · 남은 원금 <strong>{fmtWon(p.remaining_principal)}</strong> · 확인된 미지급 총액 <strong>{fmtWon(p.unpaid_total)}</strong> · 다음 예정일 {p.next_due_date ?? "완료"} · 완납 예정 {p.completion_date?.slice(0,7) ?? "완료"}</p>
        {p.installments.some(r => r.status === "needs_confirmation") && <p className="banner info">지난 예정일 중 납부 확인이 필요한 회차가 있습니다. 실제 거래를 연결하거나 예정일을 조정하세요. 해당 금액은 미래 현금 전망에 포함되지 않습니다.</p>}
        {p.needs_projection_decision && <p className="banner info">카드값 반복 규칙과 중복 여부를 확인하세요. 확인 전에는 할부 예정액을 전망에 별도로 더하지 않습니다.</p>}
        {p.conflicting_rules.length > 0 && <p>겹칠 수 있는 규칙: {p.conflicting_rules.map(r => `${r.description || `규칙 #${r.id}`} (${fmtWon(r.amount)})`).join(", ")}</p>}
        {(p.conflicting_rules.length > 0 || p.needs_projection_decision) && <div className="installment-actions">
          <button className="btn secondary" disabled={locked} onClick={() => setMode(p, "separate")}>규칙에 미포함 — 할부 별도 반영</button>
          {p.conflicting_rules.length > 0 && <button className="btn secondary" disabled={locked} onClick={() => setMode(p, "included")}>규칙에 포함 — 중복 반영 안 함</button>}
        </div>}
        {!accounts.find(a => a.id === p.cash_account_id)?.include_in_cash && p.unpaid_total > 0 && <p className="m">납부 통장이 현금 전망 계정에 포함되어 있지 않습니다. <Link to="/accounts">계정 설정</Link>에서 포함 여부를 선택하세요.</p>}
        {!p.needs_projection_decision && <p className="m">전망: {p.projection_mode === "included" ? "카드값 반복 규칙에 포함" : "미지급 회차 금액 별도 반영"}</p>}
        {expanded === p.id && <>
          <div className="table-scroll"><table className="ledger"><thead><tr><th>회차</th><th>납부 예정일</th><th className="num">원금</th><th className="num">남은 원금</th>{p.interest_account_id && <><th>미납 이자</th><th>미납 수수료</th><th>확인된 미지급 합계</th></>}<th>상태</th></tr></thead><tbody>{p.installments.map(r => <tr key={r.id}>
            <td>{r.number}회</td><td><input aria-label={`${p.description} ${r.number}회 예정일`} type="date" min={p.purchase_date} value={dates[r.id] ?? r.due_date} disabled={locked || p.allocations.some(a => a.installment_id === r.id)} onChange={e => setDates({...dates, [r.id]: e.target.value})} />{dates[r.id] && dates[r.id] !== r.due_date && <button className="btn sm secondary" disabled={locked || !dates[r.id]} onClick={() => save(`/installments/rows/${r.id}`, "PUT", {due_date: dates[r.id]})}>날짜 저장</button>}</td>
            <td className="num">{fmtWon(r.principal)}</td><td className="num">{fmtWon(r.remaining)}</td>{p.interest_account_id && <><td>{r.interest == null ? "미확인" : fmtWon(r.remaining_interest)}</td><td>{r.fee == null ? "미확인" : fmtWon(r.remaining_fee)}</td><td>{fmtWon(r.unpaid_total)}</td></>}<td>{r.status === "paid" ? "납부·환불 확인" : r.status === "needs_confirmation" ? "확인 필요" : "예정"}</td>
          </tr>)}</tbody></table></div>
          {p.interest_account_id && p.installments.map(r => <EditStatement key={r.id + "-" + data.revision} row={r}
            purchaseDate={p.purchase_date} disabled={locked} save={body => save(`/installments/rows/${r.id}/statement`, "PUT", body)} />)}
          {p.allocations.length > 0 && <ul>{p.allocations.map(a => <li key={`${a.transaction_id}-${a.installment_id}`}>{a.date} {kindLabels[a.kind]} {fmtWon(a.amount+a.interest+a.fee)} (원금 {fmtWon(a.amount)} · 이자 {fmtWon(a.interest)} · 수수료 {fmtWon(a.fee)}){a.interest_charge_id && ` · 이자 분개 #${a.interest_charge_id}`}{a.fee_charge_id && ` · 수수료 분개 #${a.fee_charge_id}`} · 거래 #{a.transaction_id} {a.description}</li>)}</ul>}
          <button className="btn secondary" disabled={locked || p.allocations.length > 0} onClick={() => {if (window.confirm("할부 일정만 삭제합니다. 구매 거래는 원장에 남습니다.")) save(`/installments/${p.id}`, "DELETE", {});}}>일정 삭제 (구매 거래 유지)</button>
        </>}
      </section>)}
      {plans.length > 0 && <section className="panel">
        <h2>실제 납부·환불 연결</h2>
        <p>먼저 <Link to="/transactions/new">거래 입력</Link>에서 실제 분개를 기록하세요. 납부는 통장을 대변에, 원금은 카드 부채, 이자·수수료는 각 비용 계정을 차변에 입력합니다. 비용을 이미 카드에 기장했다면 해당 거래를 회차에 먼저 연결하세요. 중도상환은 명세서에서 취소 이자와 추가 수수료를 확인한 뒤 배분하세요.</p>
        <fieldset disabled={locked} className="installment-form">
          <label>거래 검색 (내역 또는 거래 번호)<input value={search} onChange={e => {setSearch(e.target.value); setTransactionId("");}} /></label>
          <label>실제 거래<select value={transactionId} onChange={e => setTransactionId(e.target.value)}><option value="">거래 선택</option>{candidates.data?.map(t => <option key={t.id} value={t.id}>#{t.id} {t.date} {t.description} · {fmtWon(t.postings.filter(p => p.amount > 0).reduce((s,p) => s+p.amount,0))}</option>)}</select></label>
          <label>연결 종류<select value={kind} onChange={e => {setKind(e.target.value as typeof kind); setAmounts({});}}>{Object.entries(kindLabels).map(([v,label]) => <option key={v} value={v}>{label}</option>)}</select></label>
        </fieldset>
        {candidates.error && <p role="alert">거래 조회 실패: {candidates.error} <button className="btn" onClick={candidates.reload}>다시 조회</button></p>}
        <p className="m">최근 100건을 표시합니다. 이전 거래는 내역 또는 거래 번호로 검색하세요. 연결은 원장에 출금을 추가하지 않습니다.</p>
        {transactionId && <>
          <div className="table-scroll"><table className="ledger"><thead><tr><th>구매·회차</th><th>원금 배분</th><th>이자 배분</th><th>수수료 배분</th><th>선기장 거래</th></tr></thead>
            <tbody>{plans.flatMap(p => p.installments.map(r => {
              const label = `${p.description} ${r.number}회`;
              const charges = p.allocations.filter(a => a.installment_id === r.id && a.kind === "charge");
              return <tr key={r.id}><td>{label}</td>
                {(["amount","interest","fee"] as const).map((key,i) => <td key={key}>
                  {(key === "amount" ? ["payment","billed_payment","refund"].includes(kind) : p.interest_account_id && kind !== "refund")
                    ? <input aria-label={label + [" 배분액"," 이자 배분액"," 수수료 배분액"][i]} type="number" min="0" step="1"
                        value={amounts[r.id]?.[key] ?? ""} disabled={locked} onChange={e => changeSplit(r.id, key, e.target.value)}/> : "—"}
                </td>)}
                <td>{(kind === "billed_payment" || kind === "charge_refund") && (["interest","fee"] as const).map(key =>
                  <label key={key}>{key === "interest" ? "이자" : "수수료"} <select aria-label={label + (key === "interest" ? " 이자" : " 수수료") + " 선기장 거래"}
                    value={amounts[r.id]?.[`${key}_charge_id`] ?? ""} disabled={locked} onChange={e => changeSplit(r.id, `${key}_charge_id`, e.target.value)}>
                    <option value="">{kind === "billed_payment" ? "납부 시 직접 기장" : "선택"}</option>
                    {charges.filter(a => a[key] > 0).map(a => <option key={a.transaction_id} value={a.transaction_id}>#{a.transaction_id} {a.description}</option>)}
                  </select></label>)}</td>
              </tr>;
            }))}</tbody></table></div>
          <p>배분 합계 {fmtWon(Object.values(amounts).reduce((sum, value) => sum + splitTotal(value), 0))}</p>
          <button className="btn primary" disabled={locked} onClick={() => save("/installments/allocations", "PUT", {
            transaction_id: Number(transactionId), kind, allocations: Object.entries(amounts).filter(([,v]) => splitTotal(v) !== 0)
              .map(([id,v]) => ({installment_id: Number(id), amount: Number(v.amount || 0), interest: Number(v.interest || 0),
                fee: Number(v.fee || 0), interest_charge_id: Number(v.interest_charge_id) || null, fee_charge_id: Number(v.fee_charge_id) || null}))
          })}>배분 저장</button>{" "}
          <button className="btn secondary" disabled={locked} onClick={() => {if(window.confirm("선택한 거래의 모든 할부 배분을 해제합니다. 실제 거래는 유지됩니다.")) save("/installments/allocations", "PUT", {transaction_id: Number(transactionId), kind, allocations: []});}}>이 거래의 배분 모두 해제</button>
        </>}
      </section>}
    </>}
  </section>;
}
