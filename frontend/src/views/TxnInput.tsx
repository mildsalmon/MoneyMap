import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Account, type LastPair } from "../api";
import { fmtDelta, fmtWon, todayIso } from "../format";
import type { ViewProps } from "../App";
import { useQuery } from "./scenarios/useQuery";
import { accountPickerModel, TransactionAccountPicker } from "./TransactionAccountPicker";
import { amountInput, applyPair, chooseAccount, clearSavedDraft, editField, isCurrentLookup, itemKey,
  lookupToken, newDraft, switchMode, validateDraft, type Draft, type LookupToken, type Side, type SplitRow } from "./transactionInputState";
import "./transaction-input.css";

type Lookup = { token: LookupToken; phase: "loading" | "ready" | "error" | "confirmed"; pair?: LastPair };
const SOURCE = { empty: "선택 전", auto: "자동 선택", manual: "직접 선택", retained: "이전 입력 유지" };

export function TxnInput({ gen, refresh, showToast, go }: ViewProps) {
  const accountQuery = useQuery(`input-accounts:${gen}`, signal => api.accounts(signal));
  const recentQuery = useQuery(`input-recent:${gen}`, signal => api.recentInputs(signal));
  const cachedAccounts = useRef<Account[]>([]);
  if (accountQuery.data) cachedAccounts.current = accountQuery.data;
  const model = useMemo(() => accountPickerModel(cachedAccounts.current), [accountQuery.data]);
  const [draft, setDraft] = useState(() => newDraft(todayIso()));
  const current = useRef(draft);
  const change = (fn: (d: Draft) => Draft) => { current.current = fn(current.current); setDraft(current.current); };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [lookup, setLookup] = useState<Lookup>();
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [modeError, setModeError] = useState("");
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [debtLoading, setDebtLoading] = useState(false);
  const debtPending = useRef(false);
  const [debtMessage, setDebtMessage] = useState("");
  const amountEdits = useRef(0);
  const amountRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [shortViewport, setShortViewport] = useState(false);
  useEffect(() => {
    const resize = () => setShortViewport((window.visualViewport?.height ?? innerHeight) <= 480);
    resize(); window.visualViewport?.addEventListener("resize", resize); window.addEventListener("resize", resize);
    const shell = pageRef.current?.closest<HTMLElement>(".shell");
    const observer = new ResizeObserver(() => {
      // The toast is a sibling of main, so share the measured bar height.
      shell?.style.setProperty("--transaction-savebar-height", `${barRef.current?.offsetHeight ?? 90}px`);
      pageRef.current?.style.setProperty("--input-bar-height", `${barRef.current?.offsetHeight ?? 90}px`);
      pageRef.current?.style.setProperty("--input-summary-height", `${summaryRef.current?.offsetHeight ?? 68}px`);
    });
    if (barRef.current) observer.observe(barRef.current);
    if (summaryRef.current) observer.observe(summaryRef.current);
    return () => { observer.disconnect(); shell?.style.removeProperty("--transaction-savebar-height"); window.visualViewport?.removeEventListener("resize", resize); window.removeEventListener("resize", resize); };
  }, []);
  const key = itemKey(draft.item);
  useEffect(() => {
    if (draft.mode !== "basic" || !key || composing) return;
    const token = lookupToken(current.current), controller = new AbortController();
    setLookup({ token, phase: "loading" });
    const timer = setTimeout(() => {
      api.lastPair(key, controller.signal).then(pair => {
        if (controller.signal.aborted || !alive.current || !isCurrentLookup(current.current, token)) return;
        change(d => applyPair(d, token, pair)); setLookup({ token, phase: "ready", pair });
      }).catch(() => {
        if (!controller.signal.aborted && alive.current && isCurrentLookup(current.current, token)) {
          change(d => applyPair(d, token, { item_key: token.key, status: "none", source_transaction_id: null, debit_account_id: null, credit_account_id: null, unavailable_reason: null }));
          setLookup({ token, phase: "error" });
        }
      });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, draft.mode, draft.epoch, composing, gen]);
  const activeLookup = lookup && isCurrentLookup(draft, lookup.token) ? lookup : undefined;
  const lookupPending = draft.mode === "basic" && !!key && (!activeLookup || activeLookup.phase === "loading");
  const validation = validateDraft(draft, model.available);
  const manualPair = draft.debit.source === "manual" && draft.credit.source === "manual";
  const canSave = validation.valid && !saving && !composing && (!lookupPending || manualPair);
  const name = (id: number | null) => id === null ? "계정을 선택하세요" : model.byId.get(id)?.name ?? `#${id}`;
  const accountPath = (id: number | null) => id === null ? name(id) : model.paths.get(id) ?? name(id);
  const field = (which: "date" | "item" | "memo" | "amount", value: string) => {
    if (which === "amount") amountEdits.current++;
    setError(""); change(d => editField(d, which, value));
  };
  const select = (side: Side, id: number) => { setError(""); change(d => chooseAccount(d, side, id)); };
  const editRow = (id: number, patch: Partial<SplitRow>) => change(d => ({ ...d, revision: d.revision + 1, rows: d.rows.map(r => r.id === id ? { ...r, ...patch } : r) }));
  const closePicker = (id: number) => { setActiveRow(null); requestAnimationFrame(() => document.getElementById(`split-account-${id}`)?.focus()); };
  const toggleMode = () => {
    const result = switchMode(current.current); setModeError(result.error ?? "");
    if (!result.error) { change(() => result.draft); setActiveRow(null); setError(""); requestAnimationFrame(() => document.getElementById(result.draft.mode === "basic" ? "debit-heading" : "split-heading")?.focus()); }
  };
  const save = async (thenDashboard = false) => {
    if (savingRef.current || composingRef.current) return;
    const submitted = current.current, checked = validateDraft(submitted, model.available);
    if (!checked.valid || (lookupPending && !(submitted.debit.source === "manual" && submitted.credit.source === "manual"))) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const txn = await api.createTransaction({ date: submitted.date, description: submitted.item, memo: submitted.memo, postings: checked.postings });
      refresh();
      const delta = checked.postings.reduce((sum, p) => sum + (["asset", "liability"].includes(model.byId.get(p.account_id)?.type ?? "") ? p.amount : 0), 0);
      showToast(`${submitted.item || "거래"} · ${fmtWon(checked.debit)} 저장됨${delta ? ` · 순자산 ${fmtDelta(delta)} 반영` : ""}`, async () => {
        try { await api.deleteTransaction(txn.id); refresh(); if (alive.current) change(d => ({ ...d, epoch: d.epoch + 1 })); }
        catch { showToast("삭제하지 못했습니다. 거래 내역을 확인해 주세요."); }
      });
      if (!alive.current) return;
      const unchanged = current.current.revision === submitted.revision;
      change(d => clearSavedDraft(d, submitted));
      if (unchanged) { setActiveRow(null); if (thenDashboard) go("dashboard"); else requestAnimationFrame(() => amountRef.current?.focus()); }
    } catch (e) {
      if (alive.current) setError(`${submitted.item || "거래"}: ${e instanceof ApiError ? e.message : "저장 결과를 확인하지 못했습니다. 거래 내역을 확인해 주세요."}`);
    } finally { savingRef.current = false; if (alive.current) setSaving(false); }
  };
  const debtPair = draft.mode === "basic" && model.byId.get(draft.debit.account!)?.type === "liability" && model.byId.get(draft.credit.account!)?.type === "asset";
  const fillDebt = async () => {
    if (debtPending.current) return;
    const captured = current.current, amountRevision = amountEdits.current;
    const stillCurrent = () => alive.current && current.current.mode === "basic" && current.current.epoch === captured.epoch
      && current.current.debit.revision === captured.debit.revision && current.current.credit.revision === captured.credit.revision
      && current.current.debit.account === captured.debit.account && current.current.credit.account === captured.credit.account && amountRevision === amountEdits.current;
    debtPending.current = true; setDebtLoading(true); setDebtMessage("");
    try {
      const balances = await api.balances(1);
      if (!stillCurrent()) return;
      const balance = balances.accounts.find(a => a.account_id === captured.debit.account)?.balance ?? 0;
      if (balance < 0) field("amount", amountInput(String(-balance)));
      else setDebtMessage("오늘 갚을 부채 잔액이 없습니다. 입력한 금액은 유지했습니다.");
    } catch { if (stillCurrent()) setDebtMessage("잔액을 불러오지 못했습니다. 다시 시도하거나 금액을 입력하세요."); }
    finally { debtPending.current = false; if (alive.current) setDebtLoading(false); }
  };
  const recallText = () => {
    if (draft.mode === "split") return "분할 입력에서는 계정을 직접 선택합니다.";
    if (!key) return "아이템을 입력하면 마지막으로 저장한 계정을 불러옵니다. 비워 두어도 저장할 수 있습니다.";
    if (lookupPending) return "지난 계정을 확인하는 중…";
    if (activeLookup?.phase === "error") return "지난 계정을 불러오지 못했습니다. 계정을 직접 선택해 주세요.";
    if (activeLookup?.phase === "confirmed") return "기존 기록을 확인했습니다. 이번 거래를 저장하면 다음부터 자동 선택합니다.";
    const pair = activeLookup?.pair;
    if (pair?.status === "legacy_confirmation_required") return `입력 출처를 확인할 수 없는 이전 기록입니다. 계정을 확인한 뒤 불러와 주세요: ${accountPath(pair.debit_account_id)} → ${accountPath(pair.credit_account_id)}`;
    if (pair?.status === "unavailable") return pair.unavailable_reason === "split" ? "마지막 기록은 분할 거래입니다. 계정을 직접 선택하거나 분할 입력을 사용하세요." : "마지막 기록의 계정 조합을 사용할 수 없습니다. 계정을 직접 선택해 주세요.";
    if (pair?.status === "none") return "처음 입력하는 아이템입니다. 계정을 직접 선택해 주세요.";
    const automatic = (["debit", "credit"] as const).filter(s => draft[s].source === "auto");
    return automatic.length === 2 ? "마지막으로 저장한 계정을 선택했습니다." : automatic.length === 1
      ? `${automatic[0] === "debit" ? "차변" : "대변"}만 자동 선택했습니다. 직접 선택한 계정은 유지합니다.` : "직접 선택한 계정을 유지합니다.";
  };
  const composition = { onCompositionStart: () => { composingRef.current = true; setComposing(true); }, onCompositionEnd: () => { composingRef.current = false; setComposing(false); } };
  const nwDelta = validation.postings.reduce((sum, p) => sum + (["asset", "liability"].includes(model.byId.get(p.account_id)?.type ?? "") ? p.amount : 0), 0);

  return <div ref={pageRef} className={`txn-page${shortViewport ? " short-viewport" : ""}`}>
    <h1>거래 입력</h1><p className="txn-intro">아이템을 적고, 왼쪽과 오른쪽 계정을 선택하세요.</p>
    <form onSubmit={e => { e.preventDefault(); void save(); }} onKeyDown={e => {
      if (e.key !== "Enter") return;
      if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) { e.preventDefault(); return; }
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" && (current.current.mode !== "basic" || !["transaction-item", "transaction-amount"].includes(target.id))) e.preventDefault();
    }}>
      <div className="txn-fields">
        <div className="field txn-date"><label htmlFor="transaction-date">날짜</label><input id="transaction-date" type="date" value={draft.date} onChange={e => field("date", e.target.value)} /></div>
        <div className="field txn-item"><label htmlFor="transaction-item">아이템 <span>(선택)</span></label><input id="transaction-item" placeholder="예: 점심, 월급" value={draft.item} onChange={e => field("item", e.target.value)} {...composition} /></div>
        <div className="field txn-memo"><label htmlFor="transaction-memo">메모 <span>(선택)</span></label><textarea id="transaction-memo" rows={2} placeholder="이번 거래에 남길 내용" value={draft.memo} onChange={e => field("memo", e.target.value)} {...composition} /></div>
        {draft.mode === "basic" && <div className="field txn-amount"><label htmlFor="transaction-amount">금액</label><input ref={amountRef} id="transaction-amount" className="num" inputMode="numeric" placeholder="0" value={draft.amount} onChange={e => field("amount", amountInput(e.target.value))} {...composition} /></div>}
      </div>
      <div className="txn-recall" role="status">{recallText()}
        {activeLookup?.phase === "ready" && activeLookup.pair?.status === "legacy_confirmation_required" && <button type="button" className="btn secondary" onClick={() => {
          change(d => applyPair(d, activeLookup.token, activeLookup.pair!, true)); setLookup({ ...activeLookup, phase: "confirmed" });
        }}>이전 기록 확인 후 불러오기</button>}
      </div>
      {accountQuery.error && <p role="alert">계정을 불러오지 못했습니다. {accountQuery.error} <button type="button" className="btn secondary" onClick={accountQuery.reload}>계정 다시 불러오기</button></p>}
      {!accountQuery.data && !accountQuery.error && !model.byId.size && <p role="status">계정 확인 중…</p>}
      {accountQuery.data && !model.available.size && <p>거래를 입력할 계정을 먼저 만들어주세요. <button type="button" className="btn secondary" onClick={() => {
        if (draft.revision === 0 || confirm("작성 중인 거래를 닫고 계정 관리로 이동할까요?")) go("accounts");
      }}>계정 만들기</button></p>}
      <div className="txn-top-summary" ref={summaryRef} aria-hidden="true">
        {draft.mode === "basic" ? <><span>차변<strong>{name(draft.debit.account)}</strong></span><span>대변<strong>{name(draft.credit.account)}</strong></span></> : <span>분할 입력<strong>{draft.rows.length}개 행 · {fmtWon(validation.debit)}</strong></span>}
      </div>
      {draft.mode === "basic" ? <div className="txn-columns">{(["debit", "credit"] as const).map(side => <section key={side} aria-labelledby={`${side}-heading`}>
        <div className="txn-side-heading"><h2 id={`${side}-heading`} tabIndex={-1}>{side === "debit" ? "왼쪽 · 차변" : "오른쪽 · 대변"}</h2><details><summary>도움말</summary><p>{side === "debit" ? "자산·비용은 증가, 부채·수익·자본은 감소합니다." : "자산·비용은 감소, 부채·수익·자본은 증가합니다."}</p></details></div>
        <div className={`txn-selected${draft[side].account !== null ? " has-selection" : ""}`}><strong>{name(draft[side].account)}</strong><small>{SOURCE[draft[side].source]}</small>{draft[side].account !== null && <span>{model.paths.get(draft[side].account!)}</span>}</div>
        <TransactionAccountPicker model={model} label={side === "debit" ? "차변 계정" : "대변 계정"} value={draft[side].account} onSelect={id => select(side, id)} />
      </section>)}</div> : <section className="txn-split" aria-labelledby="split-heading"><h2 id="split-heading" tabIndex={-1}>분할 입력</h2>
        {draft.rows.map((row, index) => <div className="split-row" key={row.id}>
          <div className="split-fields">
            <div className="field split-account"><label id={`split-label-${row.id}`}>{index + 1}행 계정</label><button type="button" id={`split-account-${row.id}`} className="btn secondary" aria-labelledby={`split-label-${row.id} split-account-${row.id}`} aria-expanded={activeRow === row.id} aria-controls={activeRow === row.id ? `split-picker-${row.id}` : undefined} onClick={() => setActiveRow(activeRow === row.id ? null : row.id)}>{accountPath(row.account)}</button></div>
            <div className="field"><label htmlFor={`split-side-${row.id}`}>{index + 1}행 차변 또는 대변</label><select id={`split-side-${row.id}`} value={row.debit ? "d" : "c"} onChange={e => editRow(row.id, { debit: e.target.value === "d" })}><option value="d">차변 (+)</option><option value="c">대변 (−)</option></select></div>
            <div className="field"><label htmlFor={`split-amount-${row.id}`}>{index + 1}행 금액</label><input id={`split-amount-${row.id}`} ref={index === 0 ? amountRef : undefined} inputMode="numeric" className="num" value={row.amount} placeholder="0" aria-invalid={!!validation.errors[row.id]} aria-describedby={validation.errors[row.id] ? `split-error-${row.id}` : undefined} onChange={e => editRow(row.id, { amount: amountInput(e.target.value) })} {...composition} /></div>
            <button type="button" className="btn secondary" aria-label={`${index + 1}행 삭제`} onClick={() => { change(d => ({ ...d, revision: d.revision + 1, rows: d.rows.filter(r => r.id !== row.id) })); if (activeRow === row.id) setActiveRow(null); requestAnimationFrame(() => document.getElementById("split-add")?.focus()); }}>삭제</button>
          </div>
          {validation.errors[row.id] && <p className="txn-error" id={`split-error-${row.id}`}>{validation.errors[row.id]}</p>}
          {activeRow === row.id && <div className="split-picker" id={`split-picker-${row.id}`}><TransactionAccountPicker model={model} label={`${index + 1}행 계정`} value={row.account} onSelect={id => { editRow(row.id, { account: id }); closePicker(row.id); }} /><button type="button" className="btn secondary" onClick={() => closePicker(row.id)}>계정 선택 닫기</button></div>}
        </div>)}
        <button id="split-add" type="button" className="btn secondary" onClick={() => change(d => ({ ...d, revision: d.revision + 1, rows: [...d.rows, { id: Math.max(0, ...d.rows.map(r => r.id)) + 1, account: null, amount: "", debit: true }] }))}>+ 행 추가</button>
      </section>}
      <section className="txn-preview" aria-label="복식부기 미리보기"><h2>검산</h2><table className="ledger"><thead><tr><th>계정</th><th className="num">차변</th><th className="num">대변</th></tr></thead><tbody>
        {validation.postings.map((p, i) => <tr key={i}><td>{name(p.account_id)}</td><td className="num">{p.amount > 0 ? fmtWon(p.amount) : "—"}</td><td className="num">{p.amount < 0 ? fmtWon(-p.amount) : "—"}</td></tr>)}
        {!validation.postings.length && <tr><td colSpan={3}>금액과 계정을 채우면 여기 나타납니다.</td></tr>}
      </tbody></table>{validation.postings.length > 0 && <><p className={`txn-balance ${validation.valid ? "balanced" : ""}`}>{validation.valid ? "✓ 검산 일치" : "검산 불일치"} · 차변 {fmtWon(validation.debit)} / 대변 {fmtWon(validation.credit)}</p><p>순자산 변화 <strong>{fmtDelta(nwDelta)}</strong></p></>}</section>
      <div className="txn-options"><button type="button" className="btn secondary" onClick={toggleMode}>{draft.mode === "basic" ? "분할 입력" : "기본 입력으로"}</button>
        {debtPair && <button type="button" className="btn secondary" disabled={debtLoading} onClick={() => void fillDebt()}>{debtLoading ? "잔액 확인 중…" : "오늘 부채 잔액으로 채우기"}</button>}
        <button type="button" className="btn secondary" disabled={!canSave} onClick={() => void save(true)}>저장 후 대시보드</button></div>
      {modeError && <p role="alert" className="txn-error">{modeError}</p>}{debtMessage && <p role="status">{debtMessage}</p>}
      {error && <p role="alert" className="txn-error">{error} <button type="button" className="btn secondary" onClick={() => go("history")}>거래 내역 확인</button></p>}
      <div className="txn-savebar" ref={barRef}><div className="txn-save-amount"><span>저장할 금액</span><strong>{fmtWon(validation.debit)}</strong></div><button className="btn primary" type="submit" disabled={!canSave} aria-describedby="transaction-save-hint">{saving ? "저장 중…" : "저장 (Enter)"}</button><p id="transaction-save-hint">{lookupPending && !manualPair ? "자동 선택을 확인하거나 양쪽 계정을 직접 선택하세요." : validation.message || "저장하면 금액과 메모가 비워집니다."}</p></div>
    </form>
    <section className="txn-recent"><h2>최근 입력</h2>{recentQuery.error ? <p role="alert">최근 입력을 불러오지 못했습니다. <button className="btn secondary" onClick={recentQuery.reload}>최근 입력 다시 불러오기</button></p> : !recentQuery.data ? <p role="status">최근 입력 확인 중…</p> : !recentQuery.data.length ? <p>저장한 거래가 여기에 표시됩니다.</p> : <table className="ledger"><thead><tr><th>날짜</th><th>아이템</th><th className="recent-pair">계정</th><th className="num">금액</th></tr></thead><tbody>{recentQuery.data.map(t => <tr key={t.id}><td>{t.date}</td><td>{t.description ? <button type="button" className="recent-item" onClick={() => { field("item", t.description); change(d => ({ ...d, epoch: d.epoch + 1 })); }}>{t.description}</button> : "—"}</td><td className="recent-pair">{t.debit_account_id !== null && t.credit_account_id !== null ? `${name(t.debit_account_id)} → ${name(t.credit_account_id)}` : `${t.posting_count}개 행`}</td><td className="num">{fmtWon(t.amount)}</td></tr>)}</tbody></table>}</section>
  </div>;
}
