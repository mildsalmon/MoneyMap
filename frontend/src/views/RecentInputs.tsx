import { useEffect, useRef, useState } from "react";
import { api, type RecentInput } from "../api";
import { fmtWon } from "../format";

const PAGE_SIZE = 5;

/** Remounted on ledger generation changes, so old pages cannot outlive a save/undo. */
export function RecentInputs({ accountName, onSelect }: {
  accountName: (id: number | null) => string;
  onSelect: (description: string) => void;
}) {
  const [rows, setRows] = useState<RecentInput[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const pending = useRef<AbortController | null>(null);

  const load = async (beforeId?: number) => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true); setError(false);
    try {
      // One look-ahead row determines the end without an extra empty-page click.
      const page = await api.recentInputs(controller.signal, beforeId, PAGE_SIZE + 1);
      if (controller.signal.aborted) return;
      const next = page.slice(0, PAGE_SIZE);
      setRows(previous => beforeId === undefined ? next : [...previous, ...next.filter(row => !previous.some(old => old.id === row.id))]);
      setHasMore(page.length > PAGE_SIZE);
      setLoaded(true);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) { pending.current = null; setLoading(false); }
    }
  };

  useEffect(() => {
    void load();
    return () => { pending.current?.abort(); pending.current = null; };
  }, []);

  return <section className="txn-recent" aria-labelledby="recent-input-heading">
    <h2 id="recent-input-heading">최근 입력</h2>
    {!!rows.length && <table className="ledger"><thead><tr><th>날짜</th><th>아이템</th><th className="recent-pair">계정</th><th className="num">금액</th></tr></thead>
      <tbody>{rows.map(t => <tr key={t.id}>
        <td>{t.date}</td><td>{t.description ? <button type="button" className="recent-item" onClick={() => onSelect(t.description)}>{t.description}</button> : "—"}</td>
        <td className="recent-pair">{t.debit_account_id !== null && t.credit_account_id !== null ? `${accountName(t.debit_account_id)} → ${accountName(t.credit_account_id)}` : `${t.posting_count}개 행`}</td>
        <td className="num">{fmtWon(t.amount)}</td>
      </tr>)}</tbody></table>}
    <p role="status">{loading ? "최근 입력 확인 중…" : loaded ? rows.length ? `${rows.length}건 표시${hasMore ? "" : " · 마지막 입력입니다."}` : "저장한 거래가 여기에 표시됩니다." : ""}</p>
    {error && <p role="alert">최근 입력을 불러오지 못했습니다. <button type="button" className="btn secondary" onClick={() => void load(rows.at(-1)?.id)}>최근 입력 다시 불러오기</button></p>}
    {hasMore && !error && <button type="button" className="btn secondary" disabled={loading} onClick={() => void load(rows.at(-1)?.id)}>{loading ? "불러오는 중…" : "최근 입력 더보기"}</button>}
  </section>;
}
