import { useEffect, useMemo, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import {
  ApiError,
  accountTree,
  api,
  isGroup,
  withDescendants,
  type Account,
  type AccountSettingsResult,
  type AccountType,
} from "../api";

const TYPE_LABEL: Record<AccountType, string> = {
  asset: "자산",
  liability: "부채",
  income: "수익",
  expense: "비용",
  equity: "자본",
};

interface Props {
  account: Account;
  accounts: Account[];
  onCancel: () => void;
  onSaved: (result: AccountSettingsResult) => Promise<void> | void;
}

function accountPath(accounts: Account[], account: Account): string {
  const byId = new Map(accounts.map((candidate) => [candidate.id, candidate]));
  const parts: string[] = [];
  const seen = new Set<number>();
  let cursor: Account | undefined = account;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    parts.unshift(cursor.name);
    cursor = cursor.parent_id === null ? undefined : byId.get(cursor.parent_id);
  }
  return `${TYPE_LABEL[account.type]} / ${parts.join(" / ")}`;
}

export function AccountSettingsPanel({ account, accounts, onCancel, onSaved }: Props) {
  const [baseline] = useState(() => ({
    name: account.name,
    parentId: account.parent_id,
    isOverdraft: account.is_overdraft,
    includeInCash: account.include_in_cash,
    version: account.version,
  }));
  const [name, setName] = useState(account.name);
  const [parentId, setParentId] = useState<number | "">(account.parent_id ?? "");
  const [isOverdraft, setIsOverdraft] = useState(account.is_overdraft);
  const [includeInCash, setIncludeInCash] = useState(account.include_in_cash);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const descendants = useMemo(
    () => new Set(withDescendants(accounts, account.id).slice(1)),
    [account.id, accounts],
  );
  const candidates = useMemo(() => {
    return accountTree(accounts.filter((candidate) => (
      candidate.type === account.type
      && !candidate.archived
      && !candidate.is_system
    )))
      .map(({ account: candidate }) => candidate)
      .filter((candidate) => (
        candidate.id !== account.id
        && !descendants.has(candidate.id)
        && !candidate.is_overdraft
        && isGroup(accounts, candidate)
      ));
  }, [account.id, account.type, accounts, descendants]);

  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const currentParent = baseline.parentId === null
    ? undefined
    : accounts.find((candidate) => candidate.id === baseline.parentId);
  const currentParentNeedsMove = Boolean(currentParent && !candidateIds.has(currentParent.id));
  const selectedParent = parentId === ""
    ? undefined
    : accounts.find((candidate) => candidate.id === parentId);
  const selectedPath = selectedParent
    ? accountPath(accounts, selectedParent)
    : `${TYPE_LABEL[account.type]} / 최상위`;
  const hasChildren = accounts.some((candidate) => candidate.parent_id === account.id);
  const overdraftEligible = account.type === "asset" && !account.is_placeholder && !hasChildren;
  const normalizedName = name.trim();
  const normalizedParent = parentId === "" ? null : parentId;
  const dirty = normalizedName !== baseline.name
    || normalizedParent !== baseline.parentId
    || isOverdraft !== baseline.isOverdraft
    || includeInCash !== baseline.includeInCash;

  const submit = async () => {
    if (!normalizedName || !dirty || pending) return;
    setPending(true);
    setError("");
    try {
      const result = await api.updateAccountSettings(account.id, {
        name: normalizedName,
        parent_id: normalizedParent,
        is_overdraft: isOverdraft,
        include_in_cash: includeInCash,
        version: baseline.version,
      });
      await onSaved(result);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "account_settings_stale") {
        setError(`${caught.message} 최신 내용을 확인한 뒤 다시 시도하세요.`);
      } else {
        setError((caught as Error).message);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <tr className="account-settings-row" id={`account-settings-panel-${account.id}`}>
      <td colSpan={5}>
        <form
          className="account-settings-panel"
          aria-label={`${account.name} 계정 설정`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) {
              event.preventDefault();
              onCancel();
            }
          }}
        >
          <div className="settings-field">
            <label htmlFor={`account-name-${account.id}`}>계정 이름</label>
            <input
              ref={nameRef}
              id={`account-name-${account.id}`}
              aria-label={`${baseline.name} 이름`}
              value={name}
              disabled={pending}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
            />
          </div>

          <div className="settings-field settings-parent-field">
            <label htmlFor={`account-parent-${account.id}`}>상위 그룹</label>
            <select
              id={`account-parent-${account.id}`}
              aria-label={`${baseline.name} 상위 그룹`}
              value={parentId}
              disabled={pending}
              title={selectedPath}
              onChange={(event) => {
                setParentId(event.target.value === "" ? "" : Number(event.target.value));
                setError("");
              }}
            >
              <option value="">{TYPE_LABEL[account.type]} / 최상위</option>
              {currentParentNeedsMove && currentParent && (
                <option value={currentParent.id}>
                  {accountPath(accounts, currentParent)} · 현재 위치 · 이동 필요
                </option>
              )}
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {accountPath(accounts, candidate)}
                </option>
              ))}
            </select>
            <span className="settings-parent-path" title={selectedPath}>{selectedPath}</span>
          </div>

          <label className={`settings-overdraft${overdraftEligible ? "" : " disabled"}`}>
            <input
              type="checkbox"
              aria-label={`${account.name} 마이너스통장`}
              checked={isOverdraft}
              disabled={!overdraftEligible || pending}
              onChange={(event) => {
                setIsOverdraft(event.target.checked);
                setError("");
              }}
            />
            <span>
              마이너스통장
              {!overdraftEligible && <small>자산의 말단 계정에서만 설정할 수 있습니다</small>}
            </span>
          </label>

          {account.type === "asset" && !isGroup(accounts, account) && !account.archived && !account.is_system && (
            <label className="settings-overdraft settings-cash">
              <input type="checkbox" checked={includeInCash} disabled={pending}
                onChange={(event) => { setIncludeInCash(event.target.checked); setError(""); }} />
              <span>현금 부족 계산에 포함<small>이 계정의 잔액을 즉시 사용할 수 있는 자금으로 계산합니다.</small></span>
            </label>
          )}
          <div className="settings-actions">
            <button className="btn sm primary settings-save" type="submit" disabled={!normalizedName || !dirty || pending}>
              <Check size={13} aria-hidden="true" />
              {pending ? "저장 중…" : "변경 저장"}
            </button>
            <button className="btn sm secondary" type="button" disabled={pending} onClick={onCancel}>
              <X size={13} aria-hidden="true" />
              취소
            </button>
          </div>
          {error && <p className="row-error settings-error" role="alert">{error}</p>}
        </form>
      </td>
    </tr>
  );
}
