import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, isPostable, type Scenario, type Txn, type PlannedBody } from "../../api";
import { todayIso } from "../../format";
import { useQuery } from "./useQuery";

function useLifetime() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
export function DuplicateScenario({
  scenario,
  onChanged,
  busy,
  setBusy,
}: {
  scenario: Scenario;
  onChanged: () => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState(`${scenario.name} 복사`);
  const [description, setDescription] = useState(scenario.description);
  const [date, setDate] = useState(scenario.fork_date ?? todayIso());
  const [error, setError] = useState<Error>();
  const mounted = useLifetime();
  const navigate = useNavigate();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (error && !busy) button.current?.focus();
  }, [error, busy]);
  if (scenario.status !== "active" || scenario.rule_mode !== "live_additive")
    return null;
  const conflicts =
    error instanceof ApiError && Array.isArray(error.context.transactions)
      ? (error.context.transactions as Txn[])
      : [];
  return (
    <section>
      <h2>시나리오 복제</h2>
      <p>
        추가 규칙과 예정 거래를 복사합니다. 실제 장부는 계속 함께 반영됩니다.
      </p>
      <form
        aria-label="시나리오 복제"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(undefined);
          try {
            const result = await api.duplicateScenario(scenario.id, {
              name: name.trim(),
              description,
              fork_date: date,
              version: scenario.version,
            });
            if (mounted.current) navigate(`/scenarios/${result.scenario.id}`);
          } catch (e) {
            if (mounted.current) setError(e as Error);
          } finally {
            if (mounted.current) setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <div className="field">
            <label htmlFor="copy-name">복제 이름</label>
            <input
              id="copy-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="copy-description">복제 설명</label>
            <textarea
              id="copy-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="copy-date">복제 시작 기준일</label>
            <input
              id="copy-date"
              type="date"
              required
              max={todayIso()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <button className="btn primary" ref={button} disabled={!name.trim()}>
            복제 만들기
          </button>
        </fieldset>
      </form>
      {error && (
        <div role="alert">
          <p>{error.message}</p>
          {conflicts.length > 0 && (
            <ul>
              {conflicts.map((t) => (
                <li key={t.id}>
                  {t.date} · {t.description || `거래 ${t.id}`}
                </li>
              ))}
            </ul>
          )}
          <button className="btn" disabled={busy} onClick={onChanged}>
            입력을 유지하고 최신 버전 확인
          </button>
        </div>
      )}
    </section>
  );
}

export function PlannedTransactions({
  scenario,
  onChanged,
}: {
  scenario: Scenario;
  onChanged: () => void;
}) {
  const list = useQuery(
    `planned:${scenario.id}:${scenario.version}`,
    (signal) => api.plannedTransactions(scenario.id, signal),
  );
  const accounts = useQuery("planned-accounts", (signal) =>
    api.accounts(signal),
  );
  const blank = (): PlannedBody => ({
    date: todayIso(),
    description: "",
    postings: [
      { account_id: 0, amount: 0, currency: "KRW" },
      { account_id: 0, amount: 0, currency: "KRW" },
    ],
    scenario_version: scenario.version,
  });
  const [body, setBody] = useState(blank);
  const [editing, setEditing] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useLifetime();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (error && !busy) button.current?.focus();
  }, [error, busy]);
  const readonly = scenario.status !== "active";
  const updatePosting = (
    index: number,
    patch: Partial<PlannedBody["postings"][number]>,
  ) =>
    setBody({
      ...body,
      postings: body.postings.map((p, i) =>
        i === index ? { ...p, ...patch } : p,
      ),
    });
  const mutate = async (remove?: number) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (remove !== undefined)
        await api.deletePlanned(scenario.id, remove, scenario.version);
      else if (editing !== undefined)
        await api.updatePlanned(scenario.id, editing, {
          ...body,
          scenario_version: scenario.version,
        });
      else
        await api.createPlanned(scenario.id, {
          ...body,
          scenario_version: scenario.version,
        });
      if (!mounted.current) return;
      if (remove === undefined || remove === editing) {
        setEditing(undefined);
        setBody(blank());
      }
      onChanged();
      list.reload();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section>
      <h2>예정 거래</h2>
      <p>
        시작 기준일 다음 날 이후의 일회성 거래입니다. 조회 기간 밖의 거래도
        보존됩니다.
      </p>
      {list.error ? (
        <p role="alert">
          {list.error}{" "}
          <button className="btn" onClick={list.reload}>
            예정 거래 다시 불러오기
          </button>
        </p>
      ) : !list.data ? (
        <p role="status">예정 거래를 불러오는 중…</p>
      ) : (
        <div className="table-scroll">
          <table className="ledger">
            <caption>시나리오 예정 거래</caption>
            <thead>
              <tr>
                <th>날짜</th>
                <th>내역</th>
                <th className="num">분개</th>
                {!readonly && <th>관리</th>}
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.date}</td>
                  <td>{t.description || "(내역 없음)"}</td>
                  <td className="num">
                    {t.postings.map((p, i) => (
                      <div key={i}>
                        {accounts.data?.find((a) => a.id === p.account_id)
                          ?.name ?? p.account_id}
                        : {p.amount.amount.toLocaleString()} {p.amount.currency}
                      </div>
                    ))}
                  </td>
                  {!readonly && (
                    <td>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setEditing(t.id);
                          setError("");
                          setBody({
                            date: t.date,
                            description: t.description,
                            postings: t.postings.map((p) => ({
                              account_id: p.account_id,
                              ...p.amount,
                            })),
                            scenario_version: scenario.version,
                          });
                          document
                            .getElementById("planned-description")
                            ?.focus();
                        }}
                      >
                        수정
                      </button>
                      <button
                        className="btn danger"
                        disabled={busy}
                        onClick={() => void mutate(t.id)}
                      >
                        삭제
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {list.data.length === 0 && <p>예정 거래가 없습니다.</p>}
        </div>
      )}
      {!readonly && (
        <form
          aria-label={
            editing === undefined ? "예정 거래 추가" : "예정 거래 수정"
          }
          className="scenario-rule-form planned-form"
          onSubmit={(e) => {
            e.preventDefault();
            void mutate();
          }}
        >
          <fieldset disabled={busy}>
            <legend>
              {editing === undefined ? "예정 거래 추가" : "예정 거래 수정"}
            </legend>
            <div className="field">
              <label htmlFor="planned-description">예정 거래 내역</label>
              <input
                id="planned-description"
                value={body.description}
                onChange={(e) =>
                  setBody({ ...body, description: e.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="planned-date">예정 거래 날짜</label>
              <input
                type="date"
                id="planned-date"
                required
                value={body.date}
                onChange={(e) => setBody({ ...body, date: e.target.value })}
              />
            </div>
            {accounts.error && (
              <p role="alert">
                {accounts.error}{" "}
                <button type="button" className="btn" onClick={accounts.reload}>
                  계정 다시 불러오기
                </button>
              </p>
            )}
            {body.postings.map((p, i) => (
              <div key={i} className="field planned-posting">
                <label htmlFor={`planned-account-${i}`}>
                  분개 {i + 1} 계정
                </label>
                <select
                  id={`planned-account-${i}`}
                  required
                  value={p.account_id || ""}
                  onChange={(e) =>
                    updatePosting(i, { account_id: Number(e.target.value) })
                  }
                >
                  <option value="">계정 선택</option>
                  {accounts.data
                    ?.filter(
                      (a) =>
                        !a.is_system &&
                        a.currency === "KRW" &&
                        isPostable(accounts.data!, a),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
                <label htmlFor={`planned-amount-${i}`}>
                  분개 {i + 1} 금액 (부호 포함)
                </label>
                <input
                  className="num"
                  id={`planned-amount-${i}`}
                  type="number"
                  required
                  step="1"
                  value={p.amount}
                  onChange={(e) =>
                    updatePosting(i, { amount: Number(e.target.value) })
                  }
                />
                <label htmlFor={`planned-currency-${i}`}>
                  분개 {i + 1} 통화
                </label>
                <input
                  id={`planned-currency-${i}`}
                  readOnly
                  value={p.currency}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={body.postings.length <= 2}
                  onClick={() =>
                    setBody({
                      ...body,
                      postings: body.postings.filter((_, j) => i !== j),
                    })
                  }
                >
                  분개 {i + 1} 제거
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn"
              onClick={() =>
                setBody({
                  ...body,
                  postings: [
                    ...body.postings,
                    {
                      account_id: 0,
                      amount: 0,
                      currency: body.postings[0].currency,
                    },
                  ],
                })
              }
            >
              분개 추가
            </button>
            <p className="num">
              금액 합계:{" "}
              {body.postings
                .reduce((sum, p) => sum + p.amount, 0)
                .toLocaleString()}{" "}
              (같은 통화로 합계 0을 입력하세요)
            </p>
            <button
              ref={button}
              className="btn primary"
              disabled={!accounts.data}
            >
              예정 거래 저장
            </button>
            {editing !== undefined && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setEditing(undefined);
                  setBody(blank());
                  setError("");
                }}
              >
                수정 취소
              </button>
            )}
          </fieldset>
        </form>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button className="btn" disabled={busy} onClick={onChanged}>
            입력을 유지하고 최신 버전 확인
          </button>
        </p>
      )}
    </section>
  );
}
