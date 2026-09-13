/**
 * 거래 내역 — 조회, 단건 수정, 삭제.
 * 삭제 엣지 (D20 표 최소 반영): 개시잔액·규칙 생성 거래 삭제와
 * fork 이전 거래 삭제는 시나리오·잔액에 영향 — confirm 문구로 고지.
 */
import { useLayoutEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, type Txn } from "../api";
import { fmtWon } from "../format";
import type { ViewProps } from "../App";
import { useQuery } from "./scenarios/useQuery";
import { historyReturn, recalledHistory, rememberHistory } from "./transactionEditState";

export function History({ gen, refresh, showToast, go }: ViewProps) {
  const query = useQuery(`history:${gen}`, signal => Promise.all([api.transactions(1, signal), api.accounts(signal)]));
  const navigate = useNavigate(), location = useLocation();
  const [params, setParams] = useSearchParams();
  const tagFilter = params.get("tag") ?? "";
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoredKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!query.data || restoredKey.current === location.key) return;
    const remembered = location.state?.restore ?? recalledHistory(location.key);
    if (!remembered) return;
    const snapshot = historyReturn(remembered);
    const frame = requestAnimationFrame(() => {
      restoredKey.current = location.key;
      const button = snapshot.focusId === null ? null : document.getElementById(`edit-transaction-${snapshot.focusId}`);
      (button ?? document.getElementById("history-title"))?.focus({ preventScroll: true });
      if (scrollRef.current) scrollRef.current.scrollLeft = snapshot.scrollLeft;
      const main = scrollRef.current?.closest<HTMLElement>(".main");
      if (main) main.scrollTop = snapshot.scrollY;
    });
    return () => cancelAnimationFrame(frame);
  }, [query.data, location.key, location.state]);
  const edit = (id: number) => {
    const snapshot = { tagFilter, scrollY: scrollRef.current?.closest<HTMLElement>(".main")?.scrollTop ?? 0, scrollLeft: scrollRef.current?.scrollLeft ?? 0, focusId: id };
    rememberHistory(location.key, snapshot);
    navigate(`/transactions/${id}/edit`, { state: { returnTo: snapshot } });
  };
  const allTxns = query.data ? [...query.data[0]].reverse() : [];
  const tags = [...new Set([...allTxns.flatMap(txn => txn.tags ?? []), ...(tagFilter ? [tagFilter] : [])])].sort((a, b) => a.localeCompare(b, "ko"));
  const txns = tagFilter ? allTxns.filter(txn => (txn.tags ?? []).includes(tagFilter)) : allTxns;
  const accounts = query.data?.[1] ?? [];

  const nameOf = useMemo(() => {
    const m = new Map(accounts.map((a) => [a.id, a.name]));
    return (id: number) => m.get(id) ?? `#${id}`;
  }, [accounts]);

  const remove = async (t: Txn) => {
    const warnings = [
      "이 거래를 삭제합니다 — 복구할 수 없습니다.",
      t.description.startsWith("개시잔액") ? "⚠ 개시잔액 거래입니다. 삭제하면 이 계정의 시작 잔액이 사라집니다." : "",
      t.source_rule_id ? "⚠ 반복 규칙이 자동 생성한 거래입니다. 삭제해도 규칙은 유지됩니다." : "",
      "⚠ 분기일이 이 거래 이후인 시나리오가 있다면 그 곡선도 함께 재계산됩니다.",
    ].filter(Boolean).join("\n");
    if (!window.confirm(warnings)) return;
    await api.deleteTransaction(t.id);
    refresh();
    showToast("거래를 삭제했습니다");
  };

  const flow = (t: Txn) => {
    const debits = t.postings.filter((p) => p.amount.amount > 0).map((p) => nameOf(p.account_id));
    const credits = t.postings.filter((p) => p.amount.amount < 0).map((p) => nameOf(p.account_id));
    return `${credits.join("+")} → ${debits.join("+")}`;
  };

  return (
    <div>
      <h1 id="history-title" tabIndex={-1}>거래 내역</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 14 }}>
        거래 한 건의 날짜, 내역, 금액, 계정, 메모와 태그를 수정할 수 있습니다.
      </p>
      {location.state?.notice && <p role="status">{location.state.notice}</p>}
      {!!tags.length && <div className="history-tag-filter"><label htmlFor="history-tag">태그</label> <select id="history-tag" value={tagFilter} onChange={event => setParams(event.target.value ? { tag: event.target.value } : {}, { replace: true })}><option value="">전체</option>{tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select>{tagFilter && <span> · {txns.length}건</span>}</div>}
      {query.error && <p role="alert">거래 내역을 불러오지 못했습니다. {query.error} <button className="btn secondary" onClick={query.reload}>다시 불러오기</button></p>}
      {!query.data && !query.error && <p role="status">거래 내역 확인 중…</p>}
      <div className="table-scroll history-scroll" ref={scrollRef}>
        <table className="ledger">
          <thead>
            <tr><th>날짜</th><th>내역</th><th>흐름</th><th className="num">금액</th><th /></tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.id}>
                <td style={{ width: 100, color: "var(--muted)" }}>{t.date}</td>
                <td>{t.description || "—"} {t.source_rule_id && <span className="badge auto">자동</span>} {(t.tags ?? []).map(tag => <span className="badge tag" key={tag}>{tag}</span>)}
                  {t.memo && <details className="transaction-memo"><summary>메모 보기</summary><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{t.memo}</p></details>}</td>
                <td style={{ color: "var(--muted)", fontSize: 12.5 }}>{flow(t)}</td>
                <td className="num">
                  {fmtWon(t.postings.filter((p) => p.amount.amount > 0).reduce((s, p) => s + p.amount.amount, 0))}
                </td>
                <td style={{ width: 120 }}>
                  <button id={`edit-transaction-${t.id}`} className="btn sm secondary" onClick={() => edit(t.id)}>수정</button>{" "}
                  <button className="btn sm danger" onClick={() => remove(t)}>삭제</button>
                </td>
              </tr>
            ))}
            {query.data && txns.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <div className="history-empty">
                    <span>{tagFilter ? "이 태그의 거래가 없습니다." : "아직 거래가 없습니다."}</span>
                    <button type="button" className="btn sm secondary" onClick={() => go("input")}>
                      거래 입력
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
