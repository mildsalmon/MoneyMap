import { useEffect, useState } from "react";
import { api, isPostable, type Account, type Rule } from "../api";
import { commaInput, fmtWon, todayIso } from "../format";
import type { ViewProps } from "../App";


export function humanSchedule(spec: string): string {
  const m = spec.match(/^monthly:(\d+)$/);
  if (m) return `매월 ${m[1]}일`;
  const w = spec.match(/^weekly:(\w+)$/);
  const days: Record<string, string> = { mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토", sun: "일" };
  if (w) return `매주 ${days[w[1]] ?? w[1]}요일`;
  return spec;
}

export function RuleForm({
  scenarioId,
  accounts,
  onSaved,
}: {
  scenarioId: number;
  accounts: Account[];
  onSaved: (r: Rule) => void;
}) {
  const [desc, setDesc] = useState("");
  const [from, setFrom] = useState<number | "">("");
  const [to, setTo] = useState<number | "">("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(25);
  const [err, setErr] = useState("");
  const idPrefix = `rule-${scenarioId}`;

  const save = async () => {
    setErr("");
    const { value } = commaInput(amount);
    if (!value || from === "" || to === "") return;
    try {
      const r = await api.createRule({
        scenario_id: scenarioId,
        description: desc.trim(),
        from_account_id: from as number,
        to_account_id: to as number,
        amount: value,
        schedule: `monthly:${day}`,
        start_date: todayIso(),
      });
      setDesc(""); setAmount("");
      onSaved(r);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  return (
    <div className="rule-form">
      <div className="field"><label htmlFor={`${idPrefix}-description`}>내역</label>
        <input id={`${idPrefix}-description`} style={{ width: 140 }} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="예: 월급" /></div>
      <div className="field"><label htmlFor={`${idPrefix}-from`}>어디서 (from)</label>
        <select id={`${idPrefix}-from`} value={from} onChange={(e) => setFrom(Number(e.target.value))}>
          <option value="">선택</option>
          {accounts.filter((a) => !a.is_system && isPostable(accounts, a)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select></div>
      <div className="field"><label htmlFor={`${idPrefix}-to`}>어디로 (to)</label>
        <select id={`${idPrefix}-to`} value={to} onChange={(e) => setTo(Number(e.target.value))}>
          <option value="">선택</option>
          {accounts.filter((a) => !a.is_system && isPostable(accounts, a)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select></div>
      <div className="field"><label htmlFor={`${idPrefix}-amount`}>금액/회</label>
        <input id={`${idPrefix}-amount`} className="num" style={{ width: 120 }} value={amount} placeholder="0"
          onChange={(e) => setAmount(commaInput(e.target.value).display)}
          onKeyDown={(e) => e.key === "Enter" && save()} /></div>
      <div className="field"><label htmlFor={`${idPrefix}-day`}>매월</label>
        <select id={`${idPrefix}-day`} value={day} onChange={(e) => setDay(Number(e.target.value))}>
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}일</option>)}
        </select></div>
      <button className="btn primary" onClick={save}
        disabled={!commaInput(amount).value || from === "" || to === ""}>규칙 추가</button>
      {err && <span className="err" role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{err}</span>}
    </div>
  );
}

export function Rules({ gen, refresh, showToast }: ViewProps) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [deleteErrors, setDeleteErrors] = useState<Record<number, string>>({});

  useEffect(() => {
    api.rules(1).then(setRules);
    api.accounts().then(setAccounts);
  }, [gen]);

  const nameOf = (id: number) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;

  return (
    <div>
      <h1>반복 규칙</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
        월급·월세·카드값처럼 반복되는 거래를 등록하면 실행일에 자동으로 장부에 기록됩니다.
        매월 31일 규칙은 짧은 달에 말일로 당겨집니다.
      </p>

      <div className="panel rules-workspace" style={{ marginBottom: 20 }}>
        <h4>새 규칙</h4>
        <RuleForm scenarioId={1} accounts={accounts} onSaved={(r) => {
          refresh();
          showToast(`규칙 "${r.description || humanSchedule(r.schedule.spec)}" 등록됨 — 다음 실행일부터 자동 기록`);
        }} />
      </div>

      <div className="table-scroll rules-workspace">
        <table className="ledger">
          <thead>
            <tr><th>내역</th><th>흐름</th><th className="num">금액/회</th><th>일정</th><th>마지막 실행</th><th /></tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.description || "—"}</td>
                <td style={{ color: "var(--muted)" }}>{nameOf(r.from_account_id)} → {nameOf(r.to_account_id)}</td>
                <td className="num">{fmtWon(r.amount.amount)}</td>
                <td>{humanSchedule(r.schedule.spec)}</td>
                <td style={{ color: "var(--faint)" }}>{r.last_materialized ?? "아직"}</td>
                <td style={{ width: 60 }}>
                  <button className="btn sm danger" onClick={async () => {
                    if (!window.confirm(`"${r.description || humanSchedule(r.schedule.spec)}" 규칙을 삭제합니다.\n이미 기록된 거래는 그대로 남습니다.`)) return;
                    setDeleteErrors((current) => ({ ...current, [r.id]: "" }));
                    try {
                      await api.deleteRule(r.id);
                      refresh();
                      showToast("규칙 삭제됨 — 기록된 거래는 유지됩니다");
                    } catch (error) {
                      setDeleteErrors((current) => ({ ...current, [r.id]: (error as Error).message }));
                    }
                  }}>삭제</button>
                  {deleteErrors[r.id] && (
                    <span className="row-error action-error" role="alert">{deleteErrors[r.id]}</span>
                  )}
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr><td colSpan={6} style={{ color: "var(--muted)" }}>규칙이 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
