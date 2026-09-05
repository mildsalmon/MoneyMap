import { useEffect, useRef, useState } from "react";
import {
  api,
  isPostable,
  type Scenario,
  type Rule,
  type RuleBody,
  type Account,
} from "../../api";
import { fmtWon, todayIso } from "../../format";
import { humanSchedule } from "../Rules";
import { useQuery } from "./useQuery";

function RuleEditor({
  scenario,
  rule,
  accounts,
  onSaved,
  onRefresh,
  cancel,
}: {
  scenario: Scenario;
  rule?: Rule;
  accounts: Account[];
  onSaved: () => void;
  onRefresh: () => void;
  cancel?: () => void;
}) {
  const [body, setBody] = useState<RuleBody>({
    description: rule?.description ?? "",
    from_account_id: rule?.from_account_id ?? 0,
    to_account_id: rule?.to_account_id ?? 0,
    amount: rule?.amount.amount ?? 0,
    schedule: rule?.schedule.spec ?? "monthly:25",
    start_date: rule?.start_date ?? todayIso(),
    end_date: rule?.end_date ?? null,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!busy && error) saveButton.current?.focus();
  }, [busy, error]);
  const prefix = `scenario-rule-${rule?.id ?? "new"}`;
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const data = { ...body, scenario_version: scenario.version };
      if (rule) await api.updateScenarioRule(scenario.id, rule.id, data);
      else await api.createScenarioRule(scenario.id, data);
      if (!rule) setBody({ ...body, description: "", amount: 0 });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="scenario-rule-form"
      aria-label={rule ? `${rule.description} 수정` : "시나리오 규칙 추가"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="field">
        <label htmlFor={`${prefix}-description`}>내역</label>
        <input
          id={`${prefix}-description`}
          value={body.description}
          onChange={(e) => setBody({ ...body, description: e.target.value })}
        />
      </div>
      {(["from_account_id", "to_account_id"] as const).map((field, index) => (
        <div className="field" key={field}>
          <label htmlFor={`${prefix}-${field}`}>
            {index === 0 ? "어디서 (from)" : "어디로 (to)"}
          </label>
          <select
            id={`${prefix}-${field}`}
            required
            value={body[field] || ""}
            onChange={(e) =>
              setBody({ ...body, [field]: Number(e.target.value) })
            }
          >
            <option value="">선택</option>
            {accounts
              .filter((a) => !a.is_system && isPostable(accounts, a))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </div>
      ))}
      <div className="field">
        <label htmlFor={`${prefix}-amount`}>금액/회</label>
        <input
          id={`${prefix}-amount`}
          type="number"
          min={1}
          required
          value={body.amount || ""}
          onChange={(e) => setBody({ ...body, amount: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-schedule`}>일정</label>
        <input
          id={`${prefix}-schedule`}
          required
          value={body.schedule}
          onChange={(e) => setBody({ ...body, schedule: e.target.value })}
          aria-describedby={`${prefix}-hint`}
        />
        <small id={`${prefix}-hint`}>예: monthly:25, weekly:mon</small>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-start`}>규칙 시작일</label>
        <input
          id={`${prefix}-start`}
          type="date"
          required
          value={body.start_date}
          onChange={(e) => setBody({ ...body, start_date: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-end`}>규칙 종료일</label>
        <input
          id={`${prefix}-end`}
          type="date"
          value={body.end_date ?? ""}
          onChange={(e) =>
            setBody({ ...body, end_date: e.target.value || null })
          }
        />
      </div>
      <button ref={saveButton} className="btn primary" disabled={busy}>
        {rule ? "규칙 저장" : "규칙 추가"}
      </button>
      {cancel && (
        <button type="button" className="btn secondary" onClick={cancel}>
          취소
        </button>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" className="btn secondary" onClick={onRefresh}>
            입력을 유지하고 최신 버전 확인
          </button>
        </p>
      )}
    </form>
  );
}

export function ScenarioRules({
  scenario,
  onChanged,
}: {
  scenario: Scenario;
  onChanged: () => void;
}) {
  const query = useQuery(`rules:${scenario.id}:${scenario.version}`, (signal) =>
    api.effectiveRules(scenario.id, signal),
  );
  const accounts = useQuery("scenario-accounts", signal => api.accounts(signal));
  const [editing, setEditing] = useState<Rule | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <h2>시나리오 가정</h2>
      <p>
        실제 장부의 최신 규칙은 읽기 전용입니다. 이 시나리오의 추가 규칙만
        편집할 수 있습니다.
      </p>
      {query.error && (
        <p role="alert">
          {query.error}{" "}
          <button className="btn" onClick={query.reload}>
            다시 불러오기
          </button>
        </p>
      )}
      {!query.data && !query.error && <p role="status">가정을 불러오는 중…</p>}
      <div className="table-scroll">
        <table className="ledger">
          <thead>
            <tr>
              <th>규칙</th>
              <th>출처</th>
              <th className="num">금액</th>
              <th>일정</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.map(({ rule, origin, editable }) => (
              <tr key={rule.id}>
                <td>{rule.description || "이름 없는 규칙"}</td>
                <td>
                  {origin === "actual" ? "실제 · 읽기 전용" : "시나리오 전용"}
                </td>
                <td className="num">{fmtWon(rule.amount.amount)}</td>
                <td>{humanSchedule(rule.schedule.spec)}</td>
                <td>
                  {editable && (
                    <>
                      <button
                        className="btn secondary"
                        onClick={() => setEditing(rule)}
                      >
                        수정
                      </button>
                      <button
                        className="btn secondary"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setError("");
                          try {
                            await api.deleteScenarioRule(
                              scenario.id,
                              rule.id,
                              scenario.version,
                            );
                            onChanged();
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        삭제
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <p role="alert">
          {error}{" "}
          <button className="btn" onClick={onChanged}>
            최신 내용 확인
          </button>
        </p>
      )}
      {accounts.error && (
        <p role="alert">
          {accounts.error}{" "}
          <button className="btn" onClick={accounts.reload}>
            계정 다시 불러오기
          </button>
        </p>
      )}
      {scenario.status === "active" && accounts.data && (
        <RuleEditor
          key={editing?.id ?? "new"}
          scenario={scenario}
          rule={editing}
          accounts={accounts.data}
          onRefresh={onChanged}
          onSaved={() => {
            setEditing(undefined);
            onChanged();
          }}
          cancel={editing ? () => setEditing(undefined) : undefined}
        />
      )}
    </div>
  );
}
