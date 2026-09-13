import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type TransactionDetail, type TransactionEditBody, type TransactionEditResult } from "../api";
import type { ViewProps } from "../App";
import { TransactionForm } from "./TransactionForm";
import { accountPickerModel } from "./TransactionAccountPicker";
import { useQuery } from "./scenarios/useQuery";
import { editField, validateDraft, type Draft } from "./transactionInputState";
import { classifyEditResult, draftIdentity, editBody, editDraft, historyReturn, originalRows, type EditPhase } from "./transactionEditState";

export function TxnEdit(props: ViewProps) {
  const id = Number(useParams().id);
  const query = useQuery(`transaction-edit:${id}`, signal => api.transaction(id, signal));
  if (query.error) return <section><h1>거래 수정</h1><p role="alert">거래를 불러오지 못했습니다. {query.error}</p><button className="btn secondary" onClick={query.reload}>다시 불러오기</button><button className="btn secondary" onClick={() => props.go("history")}>거래 내역</button></section>;
  if (!query.data) return <section><h1>거래 수정</h1><p role="status">거래를 불러오는 중…</p></section>;
  return <EditSession key={id} {...props} initial={query.data} />;
}

function DraftSummary({ draft }: { draft: Draft }) {
  return <details className="edit-draft-summary"><summary>저장하지 못한 작성 내용</summary>
    <p>{draft.date} · {draft.item || "내역 없음"}</p><pre>{draft.memo}</pre><p>태그: {draft.tags.join(", ") || "없음"}</p>
    <p>{draft.mode === "basic" ? `차변 계정 #${draft.debit.account} / 대변 계정 #${draft.credit.account} · ${draft.amount}원`
      : draft.rows.map(r => `계정 #${r.account} ${r.debit ? "차변" : "대변"} ${r.amount}원`).join(" / ")}</p>
  </details>;
}

function EditSession({ initial, gen, refresh, showToast }: ViewProps & { initial: TransactionDetail }) {
  const navigate = useNavigate(), location = useLocation();
  const returnTo = useRef(historyReturn(location.state?.returnTo)).current;
  const accounts = useQuery(`edit-accounts:${gen}`, signal => api.accounts(signal));
  const tags = useQuery(`edit-tags:${gen}`, signal => api.tags(signal));
  const [original, setOriginal] = useState(initial);
  const [draft, setDraft] = useState(() => editDraft(initial));
  const current = useRef(draft);
  const [phase, setPhase] = useState<EditPhase>("editing");
  const phaseRef = useRef<EditPhase>("editing");
  const transition = (next: EditPhase) => { phaseRef.current = next; setPhase(next); };
  const [message, setMessage] = useState("");
  const [latest, setLatest] = useState<TransactionDetail | null>();
  const [previousDraft, setPreviousDraft] = useState<Draft>();
  const [loadingLatest, setLoadingLatest] = useState(false);
  const pending = useRef<TransactionEditBody | null>(null);
  const alive = useRef(true), allowExit = useRef(false), composing = useRef(false);
  const model = useMemo(() => accountPickerModel(accounts.data ?? []), [accounts.data]);
  const validation = validateDraft(draft, model.available, originalRows(original));
  const dirty = draftIdentity(draft) !== draftIdentity(editDraft(original));
  const locked = phase === "saving" || phase === "resolving" || phase === "uncertain";
  const protect = dirty || locked;
  const blocker = useBlocker(() => !allowExit.current && protect);
  const promptLocation = useRef<string | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (blocker.state !== "blocked") { promptLocation.current = undefined; return; }
    if (promptLocation.current === blocker.location.key) return;
    promptLocation.current = blocker.location.key;
    if (window.confirm(locked ? "저장 결과가 아직 확인되지 않았습니다. 화면을 떠날까요?" : "저장하지 않은 변경사항을 버리고 이동할까요?")) {
      allowExit.current = true; blocker.proceed();
    } else blocker.reset();
  }, [blocker, locked]);
  useEffect(() => {
    if (!protect) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [protect]);
  const change = (fn: (d: Draft) => Draft) => {
    if (["saving", "resolving", "uncertain"].includes(phaseRef.current)) return;
    current.current = fn(current.current); setDraft(current.current); setMessage("");
  };
  const field = (name: "date" | "item" | "memo" | "amount", value: string) => change(d => editField(d, name, value));
  const back = (saved?: TransactionDetail) => {
    const filtered = saved && returnTo.tagFilter && !saved.tags.includes(returnTo.tagFilter);
    const notice = saved ? (filtered ? "저장했습니다. 변경된 태그가 현재 필터와 달라 목록에 표시되지 않습니다." : "거래를 수정했습니다.") : undefined;
    if (saved) allowExit.current = true;
    navigate({ pathname: "/transactions", search: returnTo.tagFilter ? `?tag=${encodeURIComponent(returnTo.tagFilter)}` : "" },
      { replace: true, state: { restore: returnTo, notice } });
  };
  const consume = (result: TransactionEditResult, submitted: TransactionEditBody) => {
    const outcome = classifyEditResult(result, original.id, submitted);
    if (outcome === "invalid") throw new Error("저장 응답을 확인하지 못했습니다");
    if (result.outcome === "applied") refresh();
    if (!alive.current) return;
    if (outcome === "saved") { showToast("거래를 수정했습니다"); back(result.transaction!); return; }
    if (outcome === "retry") {
      pending.current = null; transition("editing"); setMessage("저장되지 않은 것을 확인했습니다. 작성 내용을 확인하고 다시 저장하세요.");
    } else {
      transition("conflict"); setLatest(result.transaction);
      setMessage("거래에 다른 변경이 있거나 삭제되었습니다. 작성 내용을 유지했습니다. 최신 거래를 확인하세요.");
    }
  };
  const checkResult = async () => {
    const submitted = pending.current;
    if (!submitted || phaseRef.current === "resolving") return;
    transition("resolving"); setMessage("저장 결과를 확인하고 있습니다…");
    try { consume(await api.resolveTransactionEdit(original.id, submitted), submitted); }
    catch { if (alive.current) { transition("uncertain"); setMessage("저장 결과 확인 필요. 작성 내용은 유지했습니다. 연결을 확인하고 결과를 다시 확인하세요."); } }
  };
  const save = async () => {
    if (phaseRef.current !== "editing" || !accounts.data || !tags.data || !original.editable || composing.current) return;
    const checked = validateDraft(current.current, model.available, originalRows(original));
    if (!checked.valid) return;
    const submitted = editBody(original, current.current, checked, crypto.randomUUID());
    pending.current = submitted; transition("saving"); setMessage("");
    try { consume(await api.editTransaction(original.id, submitted), submitted); }
    catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.code === "opening_already_recorded") {
        pending.current = null; transition("editing"); setMessage(error.message);
      } else if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        transition("conflict"); setMessage(error.message); setLatest(undefined);
      } else if (error instanceof ApiError && ([400, 413, 422].includes(error.status) || error.code === "database_busy")) {
        pending.current = null; transition("editing"); setMessage(error.message);
      } else { transition("uncertain"); await checkResult(); }
    }
  };
  const loadLatest = async () => {
    if (loadingLatest) return;
    setLoadingLatest(true);
    try { const result = await api.transaction(original.id); if (alive.current) setLatest(result); }
    catch (error) { if (alive.current) { if (error instanceof ApiError && error.status === 404) setLatest(null); else setMessage("최신 거래를 불러오지 못했습니다. 작성 내용은 유지했습니다."); } }
    finally { if (alive.current) setLoadingLatest(false); }
  };
  const useLatest = () => {
    if (!latest) return;
    setPreviousDraft(current.current); setOriginal(latest);
    const next = editDraft(latest); current.current = next; setDraft(next);
    pending.current = null; transition("editing"); setLatest(undefined); setMessage("최신 거래로 다시 수정합니다. 이전 작성 내용은 아래에서 확인할 수 있습니다.");
  };
  const opening = original.kind !== "regular";
  const targetPositive = draft.debit.account !== original.opening_system_id;
  return <TransactionForm title="거래 수정" intro="기존 거래 한 건을 수정합니다. 원본 출처와 반복 규칙은 바뀌지 않습니다."
    draft={draft} change={change} field={field} model={model} validation={validation} onSave={() => void save()}
    canSave={original.editable && !!accounts.data && !!tags.data && validation.valid && phase === "editing"}
    saving={phase === "saving"} disabled={locked || !original.editable} tags={tags.data ?? []}
    opening={opening} systemAccountId={original.opening_system_id} onComposingChange={value => { composing.current = value; }}
    saveLabel="변경사항 저장" saveHint="저장하면 이 거래 한 건만 변경됩니다."
    recall={<div className="txn-recall" role="status">{!original.editable ? "현재 지원하지 않는 통화 또는 시스템 거래입니다. 원본을 원화로 변환하지 않습니다."
      : opening ? "계정의 시작 잔액이 바뀌며 이후 잔액과 전망에도 반영됩니다."
      : original.entry_origin === "rule" ? "이 거래 한 건만 변경되며 반복 규칙과 다음 거래는 바뀌지 않습니다." : "내역을 바꿔도 선택한 계정은 유지됩니다."}</div>}
    accountStatus={<>{(accounts.error || tags.error) && <p role="alert">계정 또는 태그를 불러오지 못했습니다. 초안은 유지했습니다. <button type="button" className="btn secondary" onClick={() => { accounts.reload(); tags.reload(); }}>다시 불러오기</button></p>}
      {(!accounts.data || !tags.data) && !accounts.error && !tags.error && <p role="status">계정과 태그를 불러오는 중…</p>}</>}
    extraActions={opening && <label>개시잔액 방향 <select aria-label="개시잔액 방향" value={targetPositive ? "positive" : "negative"} onChange={e => {
      if ((e.target.value === "positive") !== targetPositive) change(d => ({ ...d, debit: d.credit, credit: d.debit, revision: d.revision + 1 }));
    }}><option value="positive">보유 (+)</option><option value="negative">부채·마이너스 (−)</option></select></label>}
    footer={<div className="edit-recovery">
      {message && <p role={phase === "editing" ? "status" : "alert"}>{message}</p>}
      {(phase === "uncertain" || phase === "resolving") && <button className="btn secondary" disabled={phase === "resolving"} onClick={() => void checkResult()}>{phase === "resolving" ? "결과 확인 중…" : "저장 결과 다시 확인"}</button>}
      {phase === "conflict" && <><DraftSummary draft={draft} /><button className="btn secondary" disabled={loadingLatest} onClick={() => void loadLatest()}>최신 거래 확인</button>
        {latest === null && <p>거래가 삭제되었습니다. 다시 생성하지 않습니다.</p>}
        {latest && <section><h2>현재 저장된 거래</h2><p>{latest.date} · {latest.description}</p><pre>{latest.memo}</pre><button className="btn secondary" onClick={useLatest}>최신 값으로 다시 수정</button></section>}</>}
      {previousDraft && <DraftSummary draft={previousDraft} />}
      <button className="btn secondary" onClick={() => back()}>취소하고 거래 내역으로</button>
    </div>}
  />;
}
