import { useState } from "react";
import { api, type Scenario, type ResolutionBody } from "../../api";
import { fmtWon } from "../../format";
import { useQuery } from "./useQuery";

export function LegacyResolution({
  scenario,
  onChanged,
}: {
  scenario: Scenario;
  onChanged: () => void;
}) {
  const query = useQuery(
    `legacy:${scenario.id}:${scenario.version}`,
    (signal) => api.legacyResolution(scenario.id, signal),
  );
  const [choices, setChoices] = useState<
    Record<number, "discard_snapshot" | "keep_as_scenario">
  >({});
  const [transactions, setTransactions] = useState<
    Record<number, { action: "move" | "delete"; date?: string }>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const complete =
    query.data &&
    query.data.rules.every((r) => choices[r.legacy_rule_id]) &&
    query.data.transaction_conflicts.every(
      (t) =>
        transactions[t.id]?.action === "delete" ||
        Boolean(
          transactions[t.id]?.date &&
            transactions[t.id].date! > scenario.fork_date!,
        ),
    );
  return (
    <section>
      <h2>기존 가정 분류</h2>
      <p>
        기존 시나리오는 복사한 규칙과 직접 추가한 규칙을 구분할 수 없습니다. 각
        규칙을 직접 분류하면 최신 실제 규칙을 사용하는 새 전망이 열립니다. 현재
        actual 후보는 참고이며 자동 선택하지 않습니다.
      </p>
      {query.error && (
        <p role="alert">
          {query.error}{" "}
          <button className="btn" onClick={query.reload}>
            다시 불러오기
          </button>
        </p>
      )}
      {!query.data && !query.error && (
        <p role="status">기존 가정을 확인하는 중…</p>
      )}
      {query.data && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!complete || busy) return;
            setBusy(true);
            setError("");
            try {
              const body: ResolutionBody = {
                version: query.data!.scenario.version,
                rule_decisions: query.data!.rules.map((r) => ({
                  legacy_rule_id: r.legacy_rule_id,
                  action: choices[r.legacy_rule_id],
                })),
                transaction_decisions: query.data!.transaction_conflicts.map(
                  (t) => ({ transaction_id: t.id, ...transactions[t.id] }),
                ),
              };
              await api.resolveLegacy(scenario.id, body);
              onChanged();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {query.data.rules.map((row) => (
            <fieldset
              key={row.legacy_rule_id}
              disabled={scenario.status === "archived" || busy}
            >
              <legend>
                {row.rule.description || `규칙 ${row.legacy_rule_id}`} ·{" "}
                {fmtWon(row.rule.amount.amount)} · {row.rule.schedule.spec}
              </legend>
              <p>
                참고 actual 후보:{" "}
                {row.actual_candidates
                  .map(
                    (r) =>
                      `${r.description || r.id} (${fmtWon(r.amount.amount)})`,
                  )
                  .join(", ") || "없음"}
              </p>
              <label>
                <input
                  type="radio"
                  name={`legacy-${row.legacy_rule_id}`}
                  checked={choices[row.legacy_rule_id] === "discard_snapshot"}
                  onChange={() =>
                    setChoices({
                      ...choices,
                      [row.legacy_rule_id]: "discard_snapshot",
                    })
                  }
                />{" "}
                snapshot 폐기
              </label>{" "}
              <label>
                <input
                  type="radio"
                  name={`legacy-${row.legacy_rule_id}`}
                  checked={choices[row.legacy_rule_id] === "keep_as_scenario"}
                  onChange={() =>
                    setChoices({
                      ...choices,
                      [row.legacy_rule_id]: "keep_as_scenario",
                    })
                  }
                />{" "}
                시나리오 추가로 유지
              </label>
            </fieldset>
          ))}
          {query.data.transaction_conflicts.map((t) => (
            <fieldset
              key={t.id}
              disabled={scenario.status === "archived" || busy}
            >
              <legend>
                {t.description || `거래 ${t.id}`} · {t.date} 날짜 충돌
              </legend>
              <label>
                처리{" "}
                <select
                  aria-label={`거래 ${t.id} 처리`}
                  value={transactions[t.id]?.action ?? ""}
                  onChange={(e) =>
                    setTransactions({
                      ...transactions,
                      [t.id]: { action: e.target.value as "move" | "delete" },
                    })
                  }
                >
                  <option value="" disabled>
                    직접 선택
                  </option>
                  <option value="move">날짜 이동</option>
                  <option value="delete">삭제</option>
                </select>
              </label>
              {transactions[t.id]?.action === "move" && (
                <label>
                  새 날짜{" "}
                  <input
                    aria-label={`거래 ${t.id} 새 날짜`}
                    type="date"
                    required
                    value={transactions[t.id].date ?? ""}
                    onChange={(e) =>
                      setTransactions({
                        ...transactions,
                        [t.id]: { action: "move", date: e.target.value },
                      })
                    }
                  />
                </label>
              )}
            </fieldset>
          ))}
          <p>
            과거 규칙 발생 거래 {query.data.generated_transactions}개는 변환 시
            제거합니다. 미래 규칙과 이중 계산하지 않습니다.
          </p>
          {scenario.status === "active" && (
            <button className="btn primary" disabled={!complete || busy}>
              분류 확정 후 새 전망 보기
            </button>
          )}
        </form>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            className="btn secondary"
            onClick={() => {
              setChoices({});
              setTransactions({});
              query.reload();
              onChanged();
            }}
          >
            최신 분류 다시 확인
          </button>
        </p>
      )}
    </section>
  );
}
