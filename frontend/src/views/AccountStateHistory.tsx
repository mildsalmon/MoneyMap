import { useState } from "react";
import { api, type Account } from "../api";
import { useQuery } from "./scenarios/useQuery";

const labels: Record<string, string> = {
  baseline: "수집 시작", create: "생성", archive: "보관", restore: "복원",
  group: "그룹 설정", reparent: "상위 계정 이동", settings: "설정 변경",
};
const eligibility = { system: "시스템 계정", archived: "보관 중", group: "그룹 계정", postable: "기장 가능", not_created: "계정 생성 전" };
const time = (stamp: string) => new Date(stamp).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });

interface HistoryProps {
  accounts: Account[];
  refresh: () => void;
  onArchiveChange: (account: Account, day: string) => Promise<void>;
  archiveReady: boolean;
  onPendingChange: (value: boolean) => void;
  gen: number;
}

function Events({ account, accounts, refresh, onArchiveChange, archiveReady, onPendingChange, gen }: HistoryProps & { account: Account }) {
  const [actionDay, setActionDay] = useState("");
  const history = useQuery(`state-history:${account.id}:${account.version}:${gen}`, signal => api.accountStateHistory(account.id, signal));
  const [seq, setSeq] = useState<number>();
  const [day, setDay] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const data = history.data;
  const name = (id: unknown) => accounts.find(a => a.id === id)?.name ?? "최상위";
  if (history.error) return <p role="alert">{history.error} <button type="button" onClick={history.reload}>이력 다시 조회</button></p>;
  if (!data) return <p role="status">이력 조회 중…</p>;
  const selected = data.events.find(e => e.seq === seq);
  async function correct() {
    if (!selected || !day || saving) return;
    setSaving(true); onPendingChange(true);
    try {
      await api.correctAccountDate(account.id, selected.seq, day, selected.revision);
      setSeq(undefined); setDay(""); setMessage("적용일을 정정했습니다."); refresh();
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); onPendingChange(false); history.reload(); }
  }
  return <>
    <p>수집 시작 {time(data.started_at)} (서울). 그 이전은 이력 미상입니다. 거래일은 서울 기준 하루의 마지막 상태를 따릅니다.</p>
    <label className="field">{account.archived ? "복원 적용일" : "보관 적용일"}
      <input type="date" value={actionDay} onChange={e => setActionDay(e.target.value)} />
    </label>
    <button type="button" className="btn secondary" disabled={!actionDay || (!account.archived && !archiveReady)}
      onClick={() => void onArchiveChange(account, actionDay)}>선택한 날부터 {account.archived ? "복원" : "보관"}</button>
    <h3>사용 가능 기간</h3>
    <ul>{data.intervals.map(i => <li key={i.start}>
      {time(i.start)}부터 {i.end ? `${time(i.end)} 전까지` : "현재까지"} · {eligibility[i.reason]}
    </li>)}</ul>
    <h3>변경 기록</h3>
    <ol>{data.events.map(e => <li key={e.seq}>
      <strong>{labels[e.action]}</strong> · {name(e.account_id)} · 적용 {time(e.applied_at)} · 순번 {e.seq}
      <small> (기록 {time(e.recorded_at)})</small>
      {e.action === "baseline" && <> · {e.after_state.archived ? "보관 상태" : "활성 상태"}{e.after_state.is_placeholder ? " · 그룹" : ""}</>}
      {e.action === "reparent" && <> · {name(e.before_state?.parent_id)} → {name(e.after_state.parent_id)}</>}
      {e.action === "group" && <> · {e.after_state.is_placeholder ? "그룹으로 변경" : "그룹 해제"}</>}
      {e.action !== "baseline" && e.account_id === account.id && <button type="button" className="btn sm secondary"
        disabled={saving} onClick={() => { setSeq(e.seq); setDay(""); setMessage(""); }}>적용일 정정</button>}
      {data.corrections.filter(c => c.batch === e.batch).map(c => <p key={c.revision}>정정 {time(c.recorded_at)} · {time(c.previous_at)} → {time(c.effective_at)}</p>)}
    </li>)}</ol>
    {selected && <div className="field">
      <label>새 적용일 <input type="date" value={day} disabled={saving} onChange={e => setDay(e.target.value)} /></label>
      <p>{labels[selected.action]} 상태를 선택한 날짜 0시부터 적용합니다.</p>
      <button type="button" className="btn primary" disabled={!day || saving} onClick={() => void correct()}>정정 저장</button>
      <button type="button" className="btn secondary" disabled={saving} onClick={() => setSeq(undefined)}>취소</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </>;
}

export function AccountStateHistory(props: HistoryProps) {
  const { accounts } = props;
  const [id, setId] = useState("");
  const account = accounts.find(a => a.id === Number(id));
  return <details className="panel"><summary>계정 상태 이력</summary>
    <label className="field">이력을 볼 계정 <select value={id} onChange={e => setId(e.target.value)}>
      <option value="">계정 선택</option>
      {accounts.filter(a => !a.is_system).map(a => <option key={a.id} value={a.id}>{a.name}{a.archived ? " (보관)" : ""}</option>)}
    </select></label>
    {account && <Events key={account.id} account={account} {...props} />}
  </details>;
}
