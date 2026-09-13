import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Account, type LastPair } from "../api";
import { fmtDelta, fmtWon, todayIso } from "../format";
import type { ViewProps } from "../App";
import { useQuery } from "./scenarios/useQuery";
import { accountPickerModel } from "./TransactionAccountPicker";
import { TransactionForm, netWorthDelta } from "./TransactionForm";
import { amountInput, applyPair, clearSavedDraft, editField, isCurrentLookup, itemKey, lookupToken, newDraft, validateDraft, type Draft, type LookupToken } from "./transactionInputState";
import "./transaction-input.css";

type Lookup = { token: LookupToken; phase: "loading" | "ready" | "error" | "confirmed"; pair?: LastPair; filled?: ("debit" | "credit")[] };

export function TxnInput({ gen, refresh, showToast, go }: ViewProps) {
  const accountQuery = useQuery(`input-accounts:${gen}`, signal => api.accounts(signal));
  const recentQuery = useQuery(`input-recent:${gen}`, signal => api.recentInputs(signal));
  const tagsQuery = useQuery(`input-tags:${gen}`, signal => api.tags(signal));
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
  const [debtLoading, setDebtLoading] = useState(false);
  const debtPending = useRef(false);
  const [debtMessage, setDebtMessage] = useState("");
  const amountEdits = useRef(0);
  const amountRef = useRef<HTMLInputElement>(null);
  const key = itemKey(draft.item);
  useEffect(() => {
    if (draft.mode !== "basic" || !key || composing) return;
    const token = lookupToken(current.current), controller = new AbortController();
    setLookup({ token, phase: "loading" });
    const timer = setTimeout(() => {
      api.lastPair(key, controller.signal).then(pair => {
        if (controller.signal.aborted || !alive.current || !isCurrentLookup(current.current, token)) return;
        const before = current.current;
        const next = applyPair(before, token, pair);
        const filled = (["debit", "credit"] as const).filter(s => before[s].account === null && next[s].account !== null);
        change(() => next); setLookup({ token, phase: "ready", pair, filled });
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
  const hasPair = draft.debit.account !== null && draft.credit.account !== null;
  const canSave = validation.valid && !saving && !composing && (!lookupPending || hasPair);
  const name = (id: number | null) => id === null ? "계정을 선택하세요" : model.byId.get(id)?.name ?? `#${id}`;
  const accountPath = (id: number | null) => id === null ? name(id) : model.paths.get(id) ?? name(id);
  const field = (which: "date" | "item" | "memo" | "amount", value: string) => {
    if (which === "amount") amountEdits.current++;
    setError(""); change(d => editField(d, which, value));
  };
  const save = async (thenDashboard = false) => {
    if (savingRef.current || composingRef.current) return;
    const submitted = current.current, checked = validateDraft(submitted, model.available);
    if (!checked.valid || (lookupPending && (submitted.debit.account === null || submitted.credit.account === null))) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const txn = await api.createTransaction({ date: submitted.date, description: submitted.item, memo: submitted.memo, tags: submitted.tags, postings: checked.postings });
      refresh();
      const delta = netWorthDelta(checked.postings, model.byId);
      showToast(`${submitted.item || "거래"} · ${fmtWon(checked.debit)} 저장됨${delta ? ` · 순자산 ${fmtDelta(delta)} 반영` : ""}`, async () => {
        try { await api.deleteTransaction(txn.id); refresh(); if (alive.current) change(d => ({ ...d, epoch: d.epoch + 1 })); }
        catch { showToast("삭제하지 못했습니다. 거래 내역을 확인해 주세요."); }
      });
      if (!alive.current) return;
      const unchanged = current.current.revision === submitted.revision;
      change(d => clearSavedDraft(d, submitted));
      if (unchanged) { if (thenDashboard) go("dashboard"); else requestAnimationFrame(() => amountRef.current?.focus()); }
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
    const automatic = (activeLookup?.filled ?? []).filter(s => draft[s].source === "auto" && draft[s].account === pair?.[`${s}_account_id`]);
    return automatic.length === 2 ? "마지막으로 저장한 계정을 선택했습니다." : automatic.length === 1
      ? `${automatic[0] === "debit" ? "차변" : "대변"}만 자동 선택했습니다. 기존 선택은 유지합니다.` : "선택한 계정을 유지합니다.";
  };
  return <TransactionForm title="거래 입력" intro="아이템을 적고, 왼쪽과 오른쪽 계정을 선택하세요."
    draft={draft} change={change} field={field} model={model} validation={validation} onSave={() => void save()}
    canSave={canSave} saving={saving} amountRef={amountRef} tags={tagsQuery.data ?? []}
    onComposingChange={value => { composingRef.current = value; setComposing(value); }}
    recall={<div className="txn-recall" role="status">{recallText()}
      {activeLookup?.phase === "ready" && activeLookup.pair?.status === "legacy_confirmation_required" && <button type="button" className="btn secondary" onClick={() => {
        change(d => applyPair(d, activeLookup.token, activeLookup.pair!, true)); setLookup({ ...activeLookup, phase: "confirmed" });
      }}>이전 기록 확인 후 불러오기</button>}
    </div>}
    accountStatus={<>
      {accountQuery.error && <p role="alert">계정을 불러오지 못했습니다. {accountQuery.error} <button type="button" className="btn secondary" onClick={accountQuery.reload}>계정 다시 불러오기</button></p>}
      {!accountQuery.data && !accountQuery.error && !model.byId.size && <p role="status">계정 확인 중…</p>}
      {accountQuery.data && !model.available.size && <p>거래를 입력할 계정을 먼저 만들어주세요. <button type="button" className="btn secondary" onClick={() => {
        if (draft.revision === 0 || confirm("작성 중인 거래를 닫고 계정 관리로 이동할까요?")) go("accounts");
      }}>계정 만들기</button></p>}
    </>}
    extraActions={<>
      {debtPair && <button type="button" className="btn secondary" disabled={debtLoading} onClick={() => void fillDebt()}>{debtLoading ? "잔액 확인 중…" : "오늘 부채 잔액으로 채우기"}</button>}
      <button type="button" className="btn secondary" disabled={!canSave} onClick={() => void save(true)}>저장 후 대시보드</button>
    </>}
    feedback={<>
      {debtMessage && <p role="status">{debtMessage}</p>}
      {error && <p role="alert" className="txn-error">{error} <button type="button" className="btn secondary" onClick={() => go("history")}>거래 내역 확인</button></p>}
    </>}
    footer={<section className="txn-recent"><h2>최근 입력</h2>{recentQuery.error ? <p role="alert">최근 입력을 불러오지 못했습니다. <button className="btn secondary" onClick={recentQuery.reload}>최근 입력 다시 불러오기</button></p> : !recentQuery.data ? <p role="status">최근 입력 확인 중…</p> : !recentQuery.data.length ? <p>저장한 거래가 여기에 표시됩니다.</p> : <table className="ledger"><thead><tr><th>날짜</th><th>아이템</th><th className="recent-pair">계정</th><th className="num">금액</th></tr></thead><tbody>{recentQuery.data.map(t => <tr key={t.id}><td>{t.date}</td><td>{t.description ? <button type="button" className="recent-item" onClick={() => { field("item", t.description); change(d => ({ ...d, epoch: d.epoch + 1 })); }}>{t.description}</button> : "—"}</td><td className="recent-pair">{t.debit_account_id !== null && t.credit_account_id !== null ? `${name(t.debit_account_id)} → ${name(t.credit_account_id)}` : `${t.posting_count}개 행`}</td><td className="num">{fmtWon(t.amount)}</td></tr>)}</tbody></table>}</section>}
  />;
}
