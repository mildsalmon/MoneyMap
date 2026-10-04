import { useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import { api, ApiError, accountTree, isPostable, type Account, type Rule, type RuleBody } from "../api";
import { fmtWon } from "../format";

const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const dayNames = ["월", "화", "수", "목", "금", "토", "일"];
export const ruleBody = (r: Rule): RuleBody => ({ description: r.description,
  from_account_id: r.from_account_id, to_account_id: r.to_account_id,
  amount: r.amount.amount, schedule: r.schedule.spec, start_date: r.start_date, end_date: r.end_date });
const sameBody = (r: Rule, body: RuleBody) => JSON.stringify(ruleBody(r)) === JSON.stringify(body);

export function ActualRuleEditor({ rule, accounts, onSaved, onCancel }: {
  rule: Rule; accounts: Account[]; onSaved: () => void; onCancel: () => void;
}) {
  const [base, setBase] = useState(rule);
  const [body, setBody] = useState(() => ruleBody(rule));
  const [phase, setPhase] = useState<"editing" | "saving" | "checking" | "conflict" | "uncertain" | "missing">("editing");
  const [message, setMessage] = useState("");
  const [latest, setLatest] = useState<Rule>();
  const busy = useRef(false), submitted = useRef<RuleBody | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const dirty = !sameBody(base, body);
  const pending = phase === "saving" || phase === "checking";
  const protectedState = dirty || phase !== "editing";
  const blocker = useBlocker(protectedState);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (!protectedState) return;
    const prevent = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [protectedState]);
  const change = <K extends keyof RuleBody>(field: K, value: RuleBody[K]) => {
    setBody(b => ({ ...b, [field]: value }));
  };
  const save = async () => {
    if (busy.current || phase !== "editing" || !base.edit_token) return;
    if (!Number.isSafeInteger(body.amount) || body.amount <= 0 || body.from_account_id === body.to_account_id
      || (body.end_date && body.end_date < body.start_date)) {
      setMessage("양수 정수 금액, 서로 다른 계정, 시작일 이후의 종료일을 확인하세요."); return;
    }
    busy.current = true; setPhase("saving"); setMessage(""); submitted.current = body;
    try {
      const saved = await api.updateRule(base.id, body, base.edit_token);
      if (!saved || saved.id !== base.id || !saved.edit_token || !sameBody(saved, body)) throw new Error("invalid receipt");
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === "rule_edit_conflict") {
        setPhase("conflict"); setMessage("다른 수정 또는 자동 생성으로 규칙이 변경되었습니다. 작성 내용은 유지했습니다.");
      } else if (e instanceof ApiError && e.code === "rule_not_found") {
        setPhase("missing"); setMessage("이 규칙은 삭제되었습니다. 작성 내용은 아래에 남겨 두었습니다.");
      } else if (e instanceof ApiError && (e.status < 500 || e.code === "database_busy")) {
        setPhase("editing"); setMessage(`저장하지 못했습니다. ${e.message}`);
      } else {
        setPhase("uncertain"); setMessage("저장 결과를 확인하지 못했습니다. 다시 저장하기 전에 최신 내용을 확인하세요.");
      }
    } finally { busy.current = false; }
  };
  const checkLatest = async () => {
    if (busy.current) return;
    const previous = phase;
    busy.current = true; setPhase("checking"); setLatest(undefined);
    try {
      const rules = await api.rules(1, AbortSignal.timeout(15_000));
      const current = rules.find(r => r.id === base.id);
      if (!current) { setPhase("missing"); setMessage("이 규칙은 삭제되었습니다. 작성 내용은 유지했습니다."); }
      else if (submitted.current && sameBody(current, submitted.current) && sameBody(current, body)) {
        onSaved();
      } else {
        setLatest(current); setPhase("conflict");
        setMessage("최신 규칙을 확인했습니다. 아래 내용과 작성 내용을 비교한 뒤 계속하세요.");
      }
    } catch (e) { setPhase(previous); setMessage(`최신 내용을 불러오지 못했습니다. ${(e as Error).message}`); }
    finally { busy.current = false; }
  };
  const prefix = `actual-rule-edit-${rule.id}`;
  const available = accountTree(accounts).map(r => r.account).filter(a => !a.is_system && isPostable(accounts, a));
  const monthly = body.schedule.startsWith("monthly:");
  const nameOf = (id: number) => accounts.find(a => a.id === id)?.name ?? `#${id}`;
  return <section className="panel actual-rule-editor" aria-labelledby={`${prefix}-title`}>
    <h2 id={`${prefix}-title`}>반복 규칙 수정</h2>
    <p className="rule-edit-help">이미 기록된 거래와 출처는 바뀌지 않습니다. 마지막 처리일({base.last_materialized ?? "아직 처리하지 않음"}) 다음 날부터 시작일·종료일 안의 미처리 날짜에 새 조건이 적용됩니다. 미처리된 과거 날짜도 포함될 수 있습니다. 저장만으로 거래가 생성되지는 않습니다.</p>
    <p className="rule-edit-help">기준 전망과 실제 규칙을 실시간으로 상속하는 시나리오(보관 포함)는 다음 조회부터 바뀝니다. 이전 방식의 복사 시나리오는 자동으로 바뀌지 않습니다.</p>
    <form aria-label="실제 반복 규칙 수정" onSubmit={e => { e.preventDefault(); void save(); }}>
      <fieldset disabled={pending || phase === "uncertain" || phase === "missing"} className="rule-edit-fields">
        <div className="field"><label htmlFor={`${prefix}-desc`}>내역</label><input ref={input} id={`${prefix}-desc`} value={body.description} onChange={e => change("description", e.target.value)} /></div>
        {(["from_account_id", "to_account_id"] as const).map((field, i) => <div className="field" key={field}>
          <label htmlFor={`${prefix}-${field}`}>{i === 0 ? "어디서 (from)" : "어디로 (to)"}</label>
          <select id={`${prefix}-${field}`} value={body[field]} required onChange={e => change(field, Number(e.target.value))}>
            {!available.some(a => a.id === body[field]) && <option value={body[field]} disabled>{nameOf(body[field])} (사용 불가)</option>}
            {available.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></div>)}
        <div className="field"><label htmlFor={`${prefix}-amount`}>금액/회 (원)</label><input className="num" id={`${prefix}-amount`} type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} required value={body.amount || ""} onChange={e => change("amount", Number(e.target.value))} /></div>
        <div className="field"><label htmlFor={`${prefix}-cycle`}>반복 주기</label><select id={`${prefix}-cycle`} value={monthly ? "monthly" : "weekly"} onChange={e => change("schedule", e.target.value === "monthly" ? "monthly:25" : "weekly:mon")}><option value="monthly">매월</option><option value="weekly">매주</option></select></div>
        <div className="field"><label htmlFor={`${prefix}-day`}>{monthly ? "실행일" : "실행 요일"}</label><select id={`${prefix}-day`} value={monthly ? Number(body.schedule.split(":")[1]) : body.schedule.split(":")[1]} onChange={e => change("schedule", `${monthly ? "monthly" : "weekly"}:${e.target.value}`)}>
          {monthly ? Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}일</option>) : weekdays.map((day, i) => <option key={day} value={day}>{dayNames[i]}요일</option>)}
        </select><small>없는 날짜는 그 달의 말일에 실행됩니다.</small></div>
        <div className="field"><label htmlFor={`${prefix}-start`}>규칙 시작일</label><input type="date" required id={`${prefix}-start`} value={body.start_date} onChange={e => change("start_date", e.target.value)} /></div>
        <div className="field"><label htmlFor={`${prefix}-end`}>규칙 종료일 (선택)</label><input type="date" min={body.start_date} id={`${prefix}-end`} value={body.end_date ?? ""} onChange={e => change("end_date", e.target.value || null)} /></div>
      </fieldset>
      <div className="rule-edit-actions"><button className="btn primary" disabled={phase !== "editing" || !base.edit_token || !dirty}>{phase === "saving" ? "저장 중…" : "규칙 저장"}</button>
        <button className="btn secondary" type="button" disabled={pending} onClick={() => {
          if (!protectedState || window.confirm(phase === "uncertain" ? "저장 결과가 아직 확인되지 않았습니다. 편집을 닫을까요?" : "작성한 변경사항을 버리고 닫을까요?")) onCancel();
        }}>취소</button>
      </div>
    </form>
    {message && <p role="alert">{message}</p>}
    {(["conflict", "uncertain"].includes(phase)) && <button className="btn secondary" onClick={() => void checkLatest()}>작성 내용을 유지하고 최신 내용 확인</button>}
    {phase === "checking" && <p role="status">최신 규칙 확인 중…</p>}
    {latest && <div className="rule-latest"><h3>서버의 최신 규칙</h3>
      <p>{latest.description || "이름 없음"} · {nameOf(latest.from_account_id)} → {nameOf(latest.to_account_id)} · {fmtWon(latest.amount.amount)} · {latest.schedule.spec}</p>
      <p>{latest.start_date} ~ {latest.end_date ?? "종료일 없음"} · 마지막 처리일: {latest.last_materialized ?? "아직"}</p>
      <button className="btn secondary" disabled={pending || !latest.edit_token} onClick={() => { setBase(latest); setLatest(undefined); setPhase("editing"); setMessage("작성 내용은 유지했습니다. 최신 규칙에 적용할 내용을 확인하고 저장하세요."); requestAnimationFrame(() => input.current?.focus()); }}>이 최신 규칙을 기준으로 계속 수정</button>
    </div>}
    {blocker.state === "blocked" && <div role="alert"><p>{pending ? "저장 결과를 확인하는 중입니다. 완료 후 이동하세요." : "작성 내용 또는 확인되지 않은 저장 결과가 있습니다. 화면을 떠날까요?"}</p>
      <button className="btn secondary" onClick={() => blocker.reset()}>계속 편집</button><button className="btn secondary" disabled={pending} onClick={() => blocker.proceed()}>화면 떠나기</button></div>}
  </section>;
}
