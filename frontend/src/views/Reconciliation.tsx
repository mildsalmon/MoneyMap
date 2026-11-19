import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { compare, confirmAdjustment, type Adjustment, type Comparison, type Statement } from "../api/reconciliation";
import { fmtMoney, todayIso } from "../format";
import { accountPickerModel } from "./TransactionAccountPicker";
import { historySearch } from "./historyQueryState";
import { useQuery } from "./scenarios/useQuery";
import "./reconciliation.css";

const digits = { KRW: 0, USD: 2, EUR: 2, JPY: 0, BHD: 3 };
type Currency = keyof typeof digits;

const pendingKey = "moneymap.reconciliation.pending";
type Pending = { command: Adjustment; input: string };

function recover(): Pending | undefined {
  try {
    const pending = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
    const statement = pending?.command?.statement;
    if (statement && Object.hasOwn(digits, statement.currency) && typeof pending.input === "string"
      && typeof pending.command.request_id === "string") return pending;
  } catch { /* No recoverable command in this tab. */ }
}

function parseMinor(value: string, currency: Currency): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[3]?.length ?? 0) > digits[currency]) return null;
  const fraction = (match[3] ?? "").padEnd(digits[currency], "0");
  return BigInt(match[1] + match[2] + fraction).toString();
}

export function Reconciliation({ refresh }: { refresh: () => void }) {
  const accounts = useQuery("reconciliation-accounts", api.accounts);
  const model = useMemo(() => accountPickerModel(accounts.data ?? []), [accounts.data]);
  const [pending, setPending] = useState<Pending | undefined>(recover);
  const restored = pending?.command.statement;
  const [accountId, setAccountId] = useState(String(restored?.account_id ?? ""));
  const [currency, setCurrency] = useState<Currency>(restored?.currency as Currency ?? "KRW");
  const [date, setDate] = useState(() => restored?.closing_date ?? todayIso());
  const [amount, setAmount] = useState(pending?.input ?? "");
  const [counterpart, setCounterpart] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{ statement: Statement; result: Comparison }>();
  const [saved, setSaved] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function reset() {
    setPreview(undefined);
    setSaved(undefined);
    setError("");
    setReason("");
    setCounterpart("");
  }

  async function calculate() {
    reset();
    const minor = parseMinor(amount, currency);
    if (minor === null || BigInt(minor) < -(2n ** 63n) || BigInt(minor) > 2n ** 63n) {
      setError(`${currency} 금액을 확인하세요. 소수점 아래 ${digits[currency]}자리까지 입력할 수 있습니다.`);
      return;
    }
    const statement = { account_id: Number(accountId), currency, closing_date: date, statement_minor: minor };
    setBusy(true);
    try {
      setPreview({ statement, result: await compare(statement) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(command: Adjustment) {
    if (busy) return;
    const attempt = { command, input: amount };
    setBusy(true);
    setError("");
    try {
      sessionStorage.setItem(pendingKey, JSON.stringify(attempt));
    } catch {
      setBusy(false);
      setError("이 탭에서 저장 요청을 보관할 수 없습니다. 브라우저 저장소를 확인하세요.");
      return;
    }
    setPending(attempt);
    try {
      const result = await confirmAdjustment(command);
      if (!Number.isSafeInteger(result?.transaction_id) || result.transaction_id <= 0) {
        throw new Error("조정 거래 번호를 확인할 수 없습니다");
      }
      sessionStorage.removeItem(pendingKey);
      setPending(undefined);
      setSaved(result.transaction_id);
      setPreview(undefined);
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        sessionStorage.removeItem(pendingKey);
        setPending(undefined);
        if (err.code === "stale_preview") setPreview(undefined);
        setError(err.message);
      } else {
        setError("저장 결과를 확인할 수 없습니다. 같은 요청으로 다시 확인하세요.");
      }
    } finally {
      setBusy(false);
    }
  }

  const options = [...model.available];
  const assetOrDebt = options.filter(id => ["asset", "liability"].includes(model.byId.get(id)!.type));
  const option = (id: number) => <option key={id} value={id}>{model.paths.get(id)}</option>;
  const money = (value: string) => fmtMoney(BigInt(value), currency);
  const delta = BigInt(preview?.result.difference_minor ?? 0);
  const debit = BigInt(preview?.result.posting_minor ?? 0) > 0n;
  const liability = model.byId.get(Number(accountId))?.type === "liability";
  return <section className="reconciliation">
    <Link to="/accounts">계정 · 개시잔액</Link>
    <h1>잔액 대사</h1>
    {accounts.error && <p role="alert">{accounts.error} <button onClick={accounts.reload}>다시 불러오기</button></p>}
    {accounts.data && !assetOrDebt.length && <p>계정 화면에서 대사할 자산 또는 부채 계정을 추가하세요.</p>}
    <form className="panel" onSubmit={event => { event.preventDefault(); void calculate(); }}>
      <fieldset disabled={busy || !!pending} className="reconcile-fields">
        <legend>명세서 기준</legend>
        <label className="field">대사 계정<select required value={accountId} onChange={e => { reset(); setAccountId(e.target.value); }}>
          <option value="">계정 선택</option>{assetOrDebt.map(option)}
        </select></label>
        <label className="field">통화<select value={currency} onChange={e => { reset(); setCurrency(e.target.value as Currency); setAmount(""); }}>
          {Object.keys(digits).map(code => <option key={code}>{code}</option>)}
        </select></label>
        <label className="field">마감일<input type="date" required value={date} onChange={e => { reset(); setDate(e.target.value); }} /></label>
        <label className="field">{liability ? "명세서 미상환액" : "명세서 잔액"} ({currency})
          <input inputMode="decimal" maxLength={25} required value={amount} onChange={e => { reset(); setAmount(e.target.value); }} />
        </label>
        {liability && <p>갚을 금액을 양수로 입력하세요.</p>}
        <button className="btn secondary" disabled={!accountId}>{preview || saved || error ? "잔액 다시 계산" : "잔액 비교"}</button>
      </fieldset>
    </form>
    {error && <p className="row-error" role="alert">{error}</p>}
    {pending && !busy && <div className="panel">
      <p>{model.paths.get(pending.command.statement.account_id)} · {pending.command.statement.closing_date} · {pending.command.reason}</p>
      <button className="btn primary" onClick={() => void save(pending.command)}>같은 요청으로 다시 확인</button>
    </div>}
    {saved && <p className="panel" role="status">조정 거래 #{saved} 기록 완료 · 확정 시점 차이 {money("0")}</p>}
    {preview && <div className="panel">
      <h2>마감 잔액 비교</h2>
      <dl className="reconcile-balances">
        <div><dt>장부 {liability ? "미상환액" : "잔액"}</dt><dd>{money(preview.result.ledger_minor)}</dd></div>
        <div><dt>명세서</dt><dd>{money(preview.statement.statement_minor)}</dd></div>
        <div><dt>차이</dt><dd>{delta > 0n ? "+" : ""}{money(delta.toString())}</dd></div>
      </dl>
      <Link target="_blank" rel="noopener" to={{ pathname: "/transactions", search: historySearch({
        start: "0001-01-01", end: date, accountId, accountScope: "direct", page: 1, tag: "",
      }) }}>마감일까지 거래 내역 열기 (새 탭)</Link>
      {delta === 0n ? <p role="status">잔액이 일치합니다.</p> :
        <form onSubmit={e => { e.preventDefault(); void save({
          statement: preview.statement, preview_version: preview.result.preview_version,
          counterpart_id: Number(counterpart), reason: reason.trim(), request_id: crypto.randomUUID(),
        }); }}>
          <fieldset className="reconcile-fields" disabled={busy || !!pending}>
            <legend>차이 조정</legend>
            <label className="field">상대 계정<select required value={counterpart} onChange={e => setCounterpart(e.target.value)}>
              <option value="">계정 선택</option>{options.filter(id => id !== Number(accountId)).map(option)}
            </select></label>
            <label className="field">조정 사유<input required maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></label>
          </fieldset>
          {counterpart && <p>{debit ? "차변" : "대변"} {model.paths.get(Number(accountId))} · {debit ? "대변" : "차변"} {model.paths.get(Number(counterpart))}
            {" · "}{fmtMoney(BigInt(preview.result.posting_minor.replace(/^-/, "")), currency)}</p>}
          <div className="reconcile-actions">
            <button className="btn primary" disabled={busy || !!pending || !reason.trim() || !counterpart}>조정 거래 확정</button>
            <button className="btn secondary" type="button" disabled={busy || !!pending} onClick={reset}>취소</button>
          </div>
        </form>}
    </div>}
  </section>;
}
