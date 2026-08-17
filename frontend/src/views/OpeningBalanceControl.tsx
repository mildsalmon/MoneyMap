import { useEffect, useRef, useState } from "react";
import type { Account, OpeningBalanceRecord } from "../api";
import { commaInput } from "../format";

type OpeningReadState = "loading" | "ready" | "error";

interface OpeningBalanceControlProps {
  account: Account;
  record?: OpeningBalanceRecord;
  zeroConfirmed: boolean;
  readState: OpeningReadState;
  disabled: boolean;
  pending: boolean;
  error?: string;
  onChange: () => void;
  onRetry: () => void;
  onRecord: (amount: number, state: "positive" | "negative") => Promise<boolean>;
  onZero: () => void;
  onUndo: (transactionId: number) => Promise<void>;
}

export function OpeningBalanceControl({
  account,
  record,
  zeroConfirmed,
  readState,
  disabled,
  pending,
  error,
  onChange,
  onRetry,
  onRecord,
  onZero,
  onUndo,
}: OpeningBalanceControlProps) {
  const [amountInput, setAmountInput] = useState("");
  const [state, setState] = useState<"positive" | "negative" | null>(null);
  const recordedButtonRef = useRef<HTMLButtonElement>(null);
  const focusRecordedAfterSave = useRef(false);
  const amount = commaInput(amountInput).value;

  useEffect(() => {
    if ((record || zeroConfirmed) && focusRecordedAfterSave.current) {
      recordedButtonRef.current?.focus();
      focusRecordedAfterSave.current = false;
    }
  }, [record, zeroConfirmed]);

  if (readState === "loading") {
    return <span className="cell-loading" aria-label="개시잔액 상태 확인 중">…</span>;
  }

  if (readState === "error") {
    return (
      <span className="cell-error" role="alert">
        불러오지 못함
        <button className="retry-action" type="button" onClick={onRetry}>
          다시 시도
        </button>
      </span>
    );
  }

  if (record) {
    return (
      <div className="opening-recorded">
        <span className="badge recorded-badge">기록됨</span>
        <button
          ref={recordedButtonRef}
          className="btn sm secondary"
          type="button"
          disabled={disabled}
          onClick={() => onUndo(record.transaction_id)}
        >
          {pending ? "취소 중…" : "기록 취소"}
        </button>
        {error && <span className="row-error" role="alert">{error}</span>}
      </div>
    );
  }

  if (zeroConfirmed) {
    return (
      <div className="opening-recorded">
        <span className="badge recorded-badge">기록됨 (0원)</span>
        <button
          ref={recordedButtonRef}
          className="btn sm secondary"
          type="button"
          disabled={disabled}
          onClick={onZero}
        >
          해제
        </button>
      </div>
    );
  }

  const selectedState = account.is_overdraft
    ? state
    : account.type === "liability"
      ? "negative"
      : "positive";
  const canRecord = amount > 0 && selectedState !== null && !disabled;

  const submit = async () => {
    if (!canRecord || selectedState === null) return;
    const succeeded = await onRecord(amount, selectedState);
    if (succeeded) {
      setAmountInput("");
      setState(null);
      focusRecordedAfterSave.current = true;
    }
  };

  return (
    <div className="opening-control">
      {account.is_overdraft && (
        <fieldset className="opening-state" disabled={disabled}>
          <legend className="sr-only">개시잔액 상태</legend>
          {(["positive", "negative"] as const).map((value) => (
            <label key={value} className={state === value ? "on" : ""}>
              <input
                type="radio"
                name={`opening-state-${account.id}`}
                value={value}
                checked={state === value}
                onChange={() => {
                  setState(value);
                  onChange();
                }}
              />
              {value === "positive" ? "예금" : "마이너스 사용"}
            </label>
          ))}
        </fieldset>
      )}
      <div className="opening-entry">
        <input
          className="opening-amount num"
          aria-label={`${account.name} 개시잔액`}
          inputMode="numeric"
          placeholder="0"
          value={amountInput}
          disabled={disabled}
          onChange={(event) => {
            setAmountInput(commaInput(event.target.value).display);
            onChange();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
        <button
          className="btn sm primary opening-submit"
          type="button"
          disabled={!canRecord}
          onClick={() => void submit()}
        >
          {pending ? "기록 중…" : "기록"}
        </button>
        <button
          className="btn sm secondary zero-confirm"
          type="button"
          disabled={disabled}
          onClick={() => {
            focusRecordedAfterSave.current = true;
            onZero();
          }}
        >
          0원으로 확인
        </button>
      </div>
      {error && <span className="row-error" role="alert">{error}</span>}
    </div>
  );
}
