import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { fmtDelta, fmtWon } from "../format";
import type { Account } from "../api";
import { TransactionAccountPicker, type AccountPickerModel } from "./TransactionAccountPicker";
import { amountInput, chooseAccount, setTags, switchMode, type Draft, type Side, type SplitRow, type validateDraft } from "./transactionInputState";
import "./transaction-input.css";

const SOURCE = { empty: "선택 전", auto: "자동 선택", manual: "직접 선택", retained: "기존 선택 유지" };
const MAX_DESCRIPTION_LENGTH = 2_000, MAX_MEMO_LENGTH = 10_000, MAX_POSTINGS = 100;
export const netWorthDelta = (postings: readonly { account_id: number; amount: number }[], accounts: ReadonlyMap<number, Account>) =>
  postings.reduce((sum, p) => sum + (["asset", "liability"].includes(accounts.get(p.account_id)?.type ?? "") ? p.amount : 0), 0);

interface Props {
  title: string; intro: string; draft: Draft; model: AccountPickerModel;
  change: (fn: (d: Draft) => Draft) => void;
  field: (field: "date" | "item" | "memo" | "amount", value: string) => void;
  validation: ReturnType<typeof validateDraft>;
  onSave: () => void; canSave: boolean; saving: boolean;
  disabled?: boolean; opening?: boolean; systemAccountId?: number | null;
  tags: string[]; saveLabel?: string; saveHint?: string;
  recall?: ReactNode; accountStatus?: ReactNode; extraActions?: ReactNode; feedback?: ReactNode; footer?: ReactNode;
  amountRef?: RefObject<HTMLInputElement | null>;
  onComposingChange?: (value: boolean) => void;
}

/** Presentation + local interaction only. Creation/edition own initialization,
 * persistence and asynchronous data; this component never queries an API. */
export function TransactionForm({ title, intro, draft, model, change, field, validation,
  onSave, canSave, saving, disabled = false, opening = false, systemAccountId = null,
  tags, saveLabel = "저장 (Enter)", saveHint = "저장하면 금액과 메모가 비워집니다.",
  recall, accountStatus, extraActions, feedback, footer, amountRef: externalAmountRef, onComposingChange }: Props) {
  const ownAmountRef = useRef<HTMLInputElement>(null);
  const amountRef = externalAmountRef ?? ownAmountRef;
  const pageRef = useRef<HTMLDivElement>(null), barRef = useRef<HTMLDivElement>(null), summaryRef = useRef<HTMLDivElement>(null);
  const [shortViewport, setShortViewport] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [modeError, setModeError] = useState("");
  const composingRef = useRef(false);
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

  const name = (id: number | null) => id === null ? "계정을 선택하세요" : model.byId.get(id)?.name ?? `#${id}`;
  const accountPath = (id: number | null) => id === null ? name(id) : model.paths.get(id) ?? name(id);
  const select = (side: Side, id: number) => change(d => chooseAccount(d, side, id));
  const toggleTag = (tag: string) => change(d => setTags(d, d.tags.includes(tag) ? d.tags.filter(value => value !== tag) : [...d.tags, tag]));
  const addTag = () => {
    const tag = tagInput.trim();
    if (!tag || tag.length > 50) return;
    change(d => setTags(d, [...d.tags, tag])); setTagInput("");
  };
  const editRow = (id: number, patch: Partial<SplitRow>) => change(d => ({ ...d, revision: d.revision + 1, rows: d.rows.map(r => r.id === id ? { ...r, ...patch } : r) }));
  const closePicker = (id: number) => { setActiveRow(null); requestAnimationFrame(() => document.getElementById(`split-account-${id}`)?.focus()); };
  const toggleMode = () => {
    const result = switchMode(draft); setModeError(result.error ?? "");
    if (!result.error) { change(() => result.draft); setActiveRow(null); requestAnimationFrame(() => document.getElementById(result.draft.mode === "basic" ? "debit-heading" : "split-heading")?.focus()); }
  };
  const composition = { onCompositionStart: () => { composingRef.current = true; onComposingChange?.(true); },
    onCompositionEnd: () => { composingRef.current = false; onComposingChange?.(false); } };
  const nwDelta = netWorthDelta(validation.postings, model.byId);
  return <div ref={pageRef} className={`txn-page${shortViewport ? " short-viewport" : ""}`}>
    <h1>{title}</h1><p className="txn-intro">{intro}</p>
    <form onSubmit={e => { e.preventDefault(); void onSave(); }} onKeyDown={e => {
      if (e.key !== "Enter") return;
      if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) { e.preventDefault(); return; }
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" && (draft.mode !== "basic" || !["transaction-item", "transaction-amount"].includes(target.id))) e.preventDefault();
    }}>
      <fieldset className="txn-form-fields" disabled={disabled} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <div className="txn-fields">
        <div className="field txn-date"><label htmlFor="transaction-date">날짜</label><input id="transaction-date" type="date" value={draft.date} onChange={e => field("date", e.target.value)} /></div>
        <div className="field txn-item"><label htmlFor="transaction-item">아이템 <span>(선택)</span></label><input id="transaction-item" maxLength={MAX_DESCRIPTION_LENGTH} placeholder="예: 점심, 월급" value={draft.item} onChange={e => field("item", e.target.value)} {...composition} /></div>
        <div className="field txn-memo"><label htmlFor="transaction-memo">메모 <span>(선택)</span></label><textarea id="transaction-memo" maxLength={MAX_MEMO_LENGTH} rows={2} placeholder="이번 거래에 남길 내용" value={draft.memo} onChange={e => field("memo", e.target.value)} {...composition} /></div>
        <div className="field txn-tags"><label htmlFor="transaction-tag">태그 <span>(선택·여러 개)</span></label><div className="tag-entry"><input id="transaction-tag" maxLength={50} placeholder="예: 데이트" value={tagInput} onChange={e => setTagInput(e.target.value)} {...composition} onKeyDown={e => { if (!composingRef.current && !e.nativeEvent.isComposing && e.keyCode !== 229 && (e.key === "Enter" || e.key === ",")) { e.preventDefault(); addTag(); } }} /><button type="button" className="btn secondary" onClick={addTag}>추가</button></div>
          {!!tags.length && <div className="tag-choices" aria-label="기존 태그">{tags.map(tag => <label key={tag} className="tag-choice"><input type="checkbox" checked={draft.tags.includes(tag)} onChange={() => toggleTag(tag)} /><span>{tag}</span></label>)}</div>}
          {!!draft.tags.length && <div className="selected-tags" aria-label="선택한 태그">{draft.tags.map(tag => <button type="button" key={tag} className="badge tag" onClick={() => toggleTag(tag)} aria-label={`${tag} 태그 제거`}>{tag} ×</button>)}</div>}
        </div>
        {draft.mode === "basic" && <div className="field txn-amount"><label htmlFor="transaction-amount">금액</label><input ref={amountRef} id="transaction-amount" className="num" inputMode="numeric" placeholder="0" value={draft.amount} onChange={e => field("amount", amountInput(e.target.value))} {...composition} /></div>}
      </div>
      {recall}
      {accountStatus}
      <div className="txn-top-summary" ref={summaryRef} aria-hidden="true">
        {draft.mode === "basic" ? <><span>차변<strong>{name(draft.debit.account)}</strong></span><span>대변<strong>{name(draft.credit.account)}</strong></span></> : <span>분할 입력<strong>{draft.rows.length}개 행 · {fmtWon(validation.debit)}</strong></span>}
      </div>
      {draft.mode === "basic" ? <div className="txn-columns">{(["debit", "credit"] as const).map(side => <section key={side} aria-labelledby={`${side}-heading`}>
        <div className="txn-side-heading"><h2 id={`${side}-heading`} tabIndex={-1}>{side === "debit" ? "왼쪽 · 차변" : "오른쪽 · 대변"}</h2><details><summary>도움말</summary><p>{side === "debit" ? "자산·비용은 증가, 부채·수익·자본은 감소합니다." : "자산·비용은 감소, 부채·수익·자본은 증가합니다."}</p></details></div>
        <div className={`txn-selected${draft[side].account !== null ? " has-selection" : ""}`}><strong>{name(draft[side].account)}</strong><small>{SOURCE[draft[side].source]}</small>{draft[side].account !== null && <span>{model.paths.get(draft[side].account!)}</span>}</div>
        {systemAccountId !== null && draft[side].account === systemAccountId ? <p>개시잔액 시스템 상대계정 · 금액은 자동 계산됩니다.</p> : <><TransactionAccountPicker model={model} label={side === "debit" ? "차변 계정" : "대변 계정"} value={draft[side].account} onSelect={id => select(side, id)} />{draft[side].account !== null && !model.available.has(draft[side].account!) && <p>현재 새 입력에는 사용할 수 없는 기존 계정입니다. 이 거래에서는 유지할 수 있습니다.</p>}</>}
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
        <button id="split-add" type="button" className="btn secondary" disabled={draft.rows.length >= MAX_POSTINGS} onClick={() => change(d => d.rows.length >= MAX_POSTINGS ? d : ({ ...d, revision: d.revision + 1, rows: [...d.rows, { id: Math.max(0, ...d.rows.map(r => r.id)) + 1, account: null, amount: "", debit: true }] }))}>+ 행 추가</button>
      </section>}
      <section className="txn-preview" aria-label="복식부기 미리보기"><h2>검산</h2><table className="ledger"><thead><tr><th>계정</th><th className="num">차변</th><th className="num">대변</th></tr></thead><tbody>
        {validation.postings.map((p, i) => <tr key={i}><td>{name(p.account_id)}</td><td className="num">{p.amount > 0 ? fmtWon(p.amount) : "—"}</td><td className="num">{p.amount < 0 ? fmtWon(-p.amount) : "—"}</td></tr>)}
        {!validation.postings.length && <tr><td colSpan={3}>금액과 계정을 채우면 여기 나타납니다.</td></tr>}
      </tbody></table>{validation.postings.length > 0 && <><p className={`txn-balance ${validation.valid ? "balanced" : ""}`}>{validation.valid ? "✓ 검산 일치" : "검산 불일치"} · 차변 {fmtWon(validation.debit)} / 대변 {fmtWon(validation.credit)}</p><p>순자산 변화 <strong>{fmtDelta(nwDelta)}</strong></p></>}</section>
      <div className="txn-options">{!opening && <button type="button" className="btn secondary" onClick={toggleMode}>{draft.mode === "basic" ? "분할 입력" : "기본 입력으로"}</button>}{extraActions}</div>
      {modeError && <p role="alert" className="txn-error">{modeError}</p>}
      {feedback}
      <div className="txn-savebar" ref={barRef}><div className="txn-save-amount"><span>저장할 금액</span><strong>{fmtWon(validation.debit)}</strong></div><button className="btn primary" type="submit" disabled={!canSave} aria-describedby="transaction-save-hint">{saving ? "저장 중…" : saveLabel}</button><p id="transaction-save-hint">{validation.message || saveHint}</p></div>
      </fieldset>
    </form>
    {footer}
  </div>;
}
