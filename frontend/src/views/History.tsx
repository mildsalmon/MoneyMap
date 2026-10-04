/** Period-bounded actual ledger. URL is applied state; input fields are drafts. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, ApiError, type Account, type Txn } from "../api";
import { fmtWon } from "../format";
import type { ViewProps } from "../App";
import { useQuery } from "./scenarios/useQuery";
import { historyReturn, recalledHistory, rememberHistory } from "./transactionEditState";
import { criteriaKey, historyCriteriaError, historyKey, historyPreset, historySearch, readHistoryQuery,
  type HistoryCriteria, type HistoryPreset, type HistoryQuery } from "./historyQueryState";
import "./history.css";

export function History(props: ViewProps) {
  const location = useLocation();
  const accounts = useQuery(`history-accounts:${props.gen}`, signal => api.accounts(signal));
  const tags = useQuery(`history-tags:${props.gen}`, signal => api.tags(signal));
  const [tagCache, setTagCache] = useState<string[]>([]);
  const [uncertainDeletes, setUncertainDeletes] = useState<Record<number, string>>({});
  useEffect(() => { if (tags.data) setTagCache(tags.data); }, [tags.data]);
  // URL changes own a fresh draft/request session. Mutation refreshes must not
  // remount it: edit restoration and drafts survive generation changes.
  return <HistorySession key={location.search} {...props} accounts={accounts} tags={tags} tagCache={tagCache}
    uncertainDeletes={uncertainDeletes} onUncertainDelete={t => setUncertainDeletes(previous => ({ ...previous, [t.id]: t.description || `#${t.id}` }))} />;
}

function HistorySession({ gen, refresh, showToast, accounts, tags, tagCache, uncertainDeletes, onUncertainDelete }: ViewProps & {
  accounts: ReturnType<typeof useQuery<Account[]>>;
  tags: ReturnType<typeof useQuery<string[]>>;
  tagCache: string[];
  uncertainDeletes: Record<number, string>;
  onUncertainDelete: (transaction: Txn) => void;
}) {
  const location = useLocation(), navigate = useNavigate();
  const parsed = useMemo(() => readHistoryQuery(new URLSearchParams(location.search)), [location.search]);
  const applied = parsed.query, queryId = applied ? historyKey(applied) : "invalid";
  const restore = useRef(historyReturn(location.state?.restore ?? recalledHistory(location.key))).current;
  const matchesRestore = !!applied && !!restore.query && historyKey(restore.query) === queryId;
  const restoreAllowed = useRef(matchesRestore);
  const [draft, setDraft] = useState<HistoryCriteria>(() => matchesRestore && restore.draft ? restore.draft
    : historyReturn({ draft: location.state?.draft }).draft ?? parsed.draft);
  const [formError, setFormError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [deleteState, setDeleteState] = useState<string | undefined>(location.state?.deleteState);
  const [deleting, setDeleting] = useState<number | null>(null);
  const deletingRef = useRef(false), alive = useRef(true), restored = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const result = useQuery(`history:${queryId}:${gen}:${attempt}`, signal => applied
    ? api.transactionHistory(historySearch(applied), signal) : Promise.resolve(null));
  const page = result.data, error = result.error ?? accounts.error;
  const ready = !!applied && !!page && !!accounts.data && !error && page.page === applied.page;
  const pending = !!applied && !ready && !error;
  const dirty = !!applied && criteriaKey(draft) !== criteriaKey(applied);
  const tagOptions = [...new Set([...(tags.data ?? tagCache), ...(draft.tag ? [draft.tag] : [])])];
  const names = useMemo(() => new Map(accounts.data?.map(a => [a.id, a.name])), [accounts.data]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    if (applied && historySearch(applied) !== location.search) {
      navigate({ search: historySearch(applied) }, { replace: true, state: location.state });
    }
  }, [applied, location.search, location.state, navigate]);
  useEffect(() => {
    if (applied && page && page.page !== applied.page) {
      // Server clamp discards old restoration, not the user's input draft.
      navigate({ search: historySearch({ ...applied, page: page.page }) }, { replace: true,
        state: { focusResults: true, draft, notice: location.state?.notice, pageCorrected: true, deleteState } });
    }
  }, [applied, page, draft, navigate, deleteState, location.state]);
  useLayoutEffect(() => {
    if (!ready || restored.current) return;
    const frame = requestAnimationFrame(() => {
      restored.current = true;
      const main = document.querySelector<HTMLElement>(".main");
      // Restore only the exact normalized conditions/page, once. gen is not a
      // reason to discard an edit return; a new query/page always is.
      if (restoreAllowed.current) {
        const button = restore.focusId ? document.getElementById(`edit-transaction-${restore.focusId}`) : null;
        (button ?? document.getElementById("history-result-title"))?.focus({ preventScroll: true });
        if (main) main.scrollTop = restore.scrollY;
        if (scrollRef.current) scrollRef.current.scrollLeft = restore.scrollLeft;
      } else if (location.state?.focusResults) {
        document.getElementById("history-result-title")?.focus({ preventScroll: true });
        if (main) main.scrollTop = 0;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, restore, location.state]);
  useEffect(() => {
    if (error && location.state?.focusResults) document.getElementById("history-query-error")?.focus();
  }, [error, location.state]);

  const apply = (criteria: HistoryCriteria, pageNumber = 1) => {
    const invalid = historyCriteriaError(criteria);
    setFormError(invalid);
    if (invalid) return;
    const next: HistoryQuery = { ...criteria, page: pageNumber };
    setDraft(criteria); restored.current = false; restoreAllowed.current = false;
    if (applied && historyKey(next) === queryId) setAttempt(a => a + 1);
    navigate({ search: historySearch(next) }, { replace: true, state: { focusResults: true } });
  };
  const change = (field: keyof HistoryCriteria, value: string) => {
    setDraft(d => ({ ...d, [field]: value })); setFormError(undefined);
  };
  const retry = () => { setAttempt(a => a + 1); if (accounts.error) accounts.reload(); };
  const edit = (id: number) => {
    if (!applied || deletingRef.current) return;
    const snapshot = { query: applied, draft, tagFilter: applied.tag, focusId: id,
      scrollY: scrollRef.current?.closest<HTMLElement>(".main")?.scrollTop ?? 0, scrollLeft: scrollRef.current?.scrollLeft ?? 0 };
    rememberHistory(location.key, snapshot);
    navigate(`/transactions/${id}/edit`, { state: { returnTo: snapshot } });
  };
  const remove = async (t: Txn) => {
    if (deletingRef.current || Object.hasOwn(uncertainDeletes, t.id)) return;
    const warnings = ["이 거래를 삭제합니다 — 복구할 수 없습니다.",
      t.description.startsWith("개시잔액") ? "⚠ 개시잔액 거래입니다. 삭제하면 이 계정의 시작 잔액이 사라집니다." : "",
      t.source_rule_id ? "⚠ 반복 규칙이 자동 생성한 거래입니다. 삭제해도 규칙은 유지됩니다." : "",
      "⚠ 분기일이 이 거래 이후인 시나리오가 있다면 그 곡선도 함께 재계산됩니다."].filter(Boolean).join("\n");
    if (!window.confirm(warnings)) return;
    deletingRef.current = true; setDeleting(t.id); setDeleteState(undefined);
    try {
      const receipt = await api.deleteTransaction(t.id);
      if (receipt?.deleted !== t.id) throw new Error("삭제 응답을 확인할 수 없습니다");
      refresh();
      if (alive.current) { setDeleteState("거래를 삭제했습니다."); showToast("거래를 삭제했습니다"); }
    } catch (err) {
      if (alive.current) {
        const rejected = err instanceof ApiError && (err.status < 500 || err.code === "database_busy");
        if (rejected) setDeleteState(`삭제하지 못했습니다. ${err.message}`);
        else onUncertainDelete(t);
      }
    } finally { deletingRef.current = false; if (alive.current) setDeleting(null); }
  };
  const flow = (t: Txn) => {
    const side = (positive: boolean) => t.postings.filter(p => positive ? p.amount.amount > 0 : p.amount.amount < 0)
      .map(p => names.get(p.account_id) ?? `#${p.account_id}`).join("+");
    return `${side(false)} → ${side(true)}`;
  };
  const savedElsewhere = ready && Number.isSafeInteger(location.state?.savedId) && !page.items.some(t => t.id === location.state.savedId);
  const presets: [HistoryPreset, string][] = [["recent", "최근 한 달"], ["this-month", "이번 달"], ["last-month", "지난달"]];
  return <div className="history-page">
    <h1 id="history-title" tabIndex={-1}>거래 내역</h1>
    <div className="history-presets" aria-label="빠른 기간 선택">{presets.map(([value, label]) => {
      const dates = historyPreset(value);
      const samePending = pending && dates.start === applied?.start && dates.end === applied?.end && draft.tag === applied?.tag;
      return <button type="button" className="btn secondary" key={value} disabled={deleting !== null || samePending}
        aria-pressed={dates.start === draft.start && dates.end === draft.end} onClick={() => apply({ ...historyPreset(value), tag: draft.tag })}>{label}</button>;
    })}</div>
    <form className="history-query" onSubmit={e => { e.preventDefault(); if ((!pending || dirty) && !deletingRef.current) apply(draft); }}>
      <label htmlFor="history-start">시작일<input id="history-start" type="date" required value={draft.start} aria-describedby={formError || parsed.error ? "history-form-error" : undefined} onChange={e => change("start", e.target.value)} /></label>
      <label htmlFor="history-end">종료일<input id="history-end" type="date" required value={draft.end} aria-describedby={formError || parsed.error ? "history-form-error" : undefined} onChange={e => change("end", e.target.value)} /></label>
      <div className="history-tag-field"><div className="history-tag-label"><label htmlFor="history-tag">태그</label>{!tags.data && !tags.error && <span role="status">목록 확인 중…</span>}</div><select id="history-tag" value={draft.tag} onChange={e => change("tag", e.target.value)}><option value="">전체</option>{tagOptions.map(tag => <option key={tag}>{tag}</option>)}</select>
        {tags.error && <div className="history-tag-error"><span role="status">태그 목록을 불러오지 못했습니다.</span><button type="button" className="btn secondary" onClick={tags.reload}>태그 목록 다시 불러오기</button></div>}</div>
      <button className="btn" disabled={(pending && !dirty) || deleting !== null}>조회</button>
    </form>
    {(formError || parsed.error) && <p id="history-form-error" role="alert">{formError ?? parsed.error}</p>}
    {dirty && <p role="status" className="history-notice">조회 버튼을 눌러 적용하세요.{ready ? " 아래는 이전 조회 결과입니다." : ""}</p>}
    {location.state?.notice && <p role="status">{location.state.notice}</p>}
    {location.state?.pageCorrected && <p role="status">마지막 유효 페이지로 이동했습니다.</p>}
    {savedElsewhere && <p role="status">수정한 거래가 다른 페이지로 이동했거나 현재 조회 결과에 없습니다. 현재 페이지를 유지했습니다.</p>}
    {deleteState && <p role="status">{deleteState}</p>}
    {!!Object.keys(uncertainDeletes).length && <div role="alert"><p>삭제 결과를 확인할 수 없습니다. 목록을 다시 조회해 주세요.</p>
      <ul>{Object.entries(uncertainDeletes).map(([id, description]) => <li key={id}>{description} (#{id})</li>)}</ul>
      <button type="button" className="btn secondary" disabled={pending} onClick={retry}>목록 다시 조회</button></div>}
    {deleting !== null && <p role="status">거래를 삭제하고 있습니다…</p>}
    <section className="history-results" aria-label="조회 결과" aria-busy={pending}>
      {applied && dirty && (pending || error) && <p className="history-notice">{error ? "재시도할 조건" : "조회 중인 조건"}: {applied.start} ~ {applied.end} · {applied.tag ? `태그 ${applied.tag}` : "태그 전체"} · {applied.page}페이지</p>}
      {applied && error && <div id="history-query-error" tabIndex={-1} role="alert"><p>거래 내역을 불러오지 못했습니다. {error}</p><button type="button" className="btn secondary" onClick={retry}>다시 조회</button></div>}
      {pending && <p role="status">거래 내역을 조회하고 있습니다…</p>}
      {ready && <>
        <h2 id="history-result-title" tabIndex={-1}>{page.total ? `전체 ${page.total.toLocaleString("ko-KR")}건 · 최신순` : "0건"}</h2>
        {!page.total ? <div className="history-empty"><span>선택한 기간과 태그에 해당하는 거래가 없습니다.</span><button className="btn secondary" onClick={() => document.getElementById("history-start")?.focus()}>조회 조건 변경</button></div>
          : <><div className="table-scroll history-scroll" ref={scrollRef} role="region" aria-label="거래 표, 가로 스크롤 가능" tabIndex={0}>
            <table className="ledger"><thead><tr><th>날짜</th><th>내역</th><th className="num">금액</th><th>흐름</th><th>작업</th></tr></thead><tbody>
              {page.items.map(t => <tr key={t.id}><td className="history-date">{t.date}</td><td className="history-description">{t.description || "—"} {t.source_rule_id && <span className="badge auto">자동</span>} {(t.tags ?? []).map(tag => <span className="badge tag" key={tag}>{tag}</span>)}
                {t.memo && <details className="transaction-memo"><summary>메모 보기</summary><p>{t.memo}</p></details>}</td>
                <td className="num">{fmtWon(t.postings.filter(p => p.amount.amount > 0).reduce((sum, p) => sum + p.amount.amount, 0))}</td><td className="history-flow">{flow(t)}</td>
                <td className="history-actions"><button id={`edit-transaction-${t.id}`} className="btn sm secondary" disabled={deleting !== null} onClick={() => edit(t.id)}>수정</button>{" "}<button className="btn sm danger" disabled={deleting !== null || Object.hasOwn(uncertainDeletes, t.id)} onClick={() => void remove(t)}>삭제</button></td></tr>)}
            </tbody></table></div>
            <nav className="history-pager" aria-label="거래 페이지"><span>{((page.page - 1) * 100 + 1).toLocaleString("ko-KR")}–{Math.min(page.page * 100, page.total).toLocaleString("ko-KR")} / {page.total.toLocaleString("ko-KR")}건</span>
              <button className="btn secondary" disabled={dirty || page.page <= 1 || deleting !== null} onClick={() => apply(applied, page.page - 1)}>이전</button><span>{page.page} / {page.total_pages}</span><button className="btn secondary" disabled={dirty || page.page >= page.total_pages || deleting !== null} onClick={() => apply(applied, page.page + 1)}>다음</button>
            </nav></>}
      </>}
    </section>
  </div>;
}
