import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Plus, Settings2 } from "lucide-react";
import {
  accountTree,
  api,
  isGroup,
  isPostable,
  withDescendants,
  type Account,
  type AccountSettingsResult,
  type AccountType,
  type BalanceRow,
  type OpeningBalanceRecord,
} from "../api";
import { fmtWon, todayIso } from "../format";
import type { ViewProps } from "../App";
import { AccountSettingsPanel } from "./AccountSettingsPanel";
import { OpeningBalanceControl } from "./OpeningBalanceControl";

const TYPE_LABEL: Record<AccountType, string> = {
  asset: "자산",
  liability: "부채",
  income: "수익",
  expense: "비용",
  equity: "자본",
};

const DISPLAY_TYPES: AccountType[] = ["asset", "liability", "income", "expense"];

interface RootDraft {
  type: AccountType;
  name: string;
  isOverdraft: boolean;
}

interface ChildDraft {
  parentId: number;
  name: string;
  isOverdraft: boolean;
}

type RowTask = "opening" | "archive" | "restore";

export function Accounts({ gen, refresh, showToast }: ViewProps) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [balances, setBalances] = useState<BalanceRow[] | null>(null);
  const [openingRecords, setOpeningRecords] = useState<OpeningBalanceRecord[] | null>(null);
  const [accountsError, setAccountsError] = useState("");
  const [balancesError, setBalancesError] = useState("");
  const [openingsError, setOpeningsError] = useState("");
  const [pageError, setPageError] = useState("");
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [rowTasks, setRowTasks] = useState<Record<number, RowTask | undefined>>({});

  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("asset");
  const [parentId, setParentId] = useState<number | "">("");
  const [advancedOverdraft, setAdvancedOverdraft] = useState(false);
  const [rootDraft, setRootDraft] = useState<RootDraft | null>(null);
  const [childDraft, setChildDraft] = useState<ChildDraft | null>(null);
  const [settingsAccountId, setSettingsAccountId] = useState<number | null>(null);
  const [reclassTargets, setReclassTargets] = useState<Record<number, number | "">>({});
  const inlineRef = useRef<HTMLInputElement>(null);

  const accountRequest = useRef<AbortController | null>(null);
  const balanceRequest = useRef<AbortController | null>(null);
  const openingRequest = useRef<AbortController | null>(null);

  const loadAccounts = useCallback(async () => {
    accountRequest.current?.abort();
    const controller = new AbortController();
    accountRequest.current = controller;
    setAccountsError("");
    try {
      const result = await api.accounts(controller.signal);
      if (controller.signal.aborted) return undefined;
      setAccounts(result);
      return result;
    } catch (caught) {
      if (controller.signal.aborted) return undefined;
      const error = caught as Error;
      setAccountsError(error.message);
      setAccounts((current) => current ?? null);
      return undefined;
    }
  }, []);

  const loadBalances = useCallback(() => {
    balanceRequest.current?.abort();
    const controller = new AbortController();
    balanceRequest.current = controller;
    setBalances(null);
    setBalancesError("");
    api.balances(1, controller.signal).then((result) => {
      if (!controller.signal.aborted) setBalances(result.accounts);
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setBalancesError(error.message);
    });
  }, []);

  const loadOpeningRecords = useCallback(() => {
    openingRequest.current?.abort();
    const controller = new AbortController();
    openingRequest.current = controller;
    setOpeningRecords(null);
    setOpeningsError("");
    api.openingBalances(controller.signal).then(result => {
      if (!controller.signal.aborted) setOpeningRecords(result);
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setOpeningsError(error.message);
    });
  }, []);

  useEffect(() => {
    void loadAccounts();
    loadBalances();
    loadOpeningRecords();
    return () => {
      accountRequest.current?.abort();
      balanceRequest.current?.abort();
      openingRequest.current?.abort();
    };
  }, [gen, loadAccounts, loadBalances, loadOpeningRecords]);

  useEffect(() => {
    inlineRef.current?.focus();
  }, [rootDraft?.type, childDraft?.parentId]);

  const accountList = accounts ?? [];
  const visible = accountList.filter((account) => !account.is_system && !account.archived);
  const archivedList = accountList.filter((account) => !account.is_system && account.archived);
  const balanceOf = (id: number) => balances?.find((balance) => balance.account_id === id);
  const openingOf = (id: number) => openingRecords?.find((record) => record.account_id === id);
  const displayAmount = (account: Account, raw: number) => account.type === "income" ? -raw : raw;

  const [zeroConfirmed, setZeroConfirmed] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("moneymap.opening_zero") ?? "[]");
    } catch {
      return [];
    }
  });

  const saveZeroConfirmed = (ids: number[]) => {
    setZeroConfirmed(ids);
    localStorage.setItem("moneymap.opening_zero", JSON.stringify(ids));
  };

  const clearRowError = (id: number) => {
    setRowErrors((current) => ({ ...current, [id]: "" }));
  };

  const setRowTask = (id: number, task?: RowTask) => {
    setRowTasks((current) => ({ ...current, [id]: task }));
  };

  const closeInlineEditors = () => {
    setRootDraft(null);
    setChildDraft(null);
    setSettingsAccountId(null);
  };

  const create = async () => {
    const draftName = name.trim();
    if (!draftName) return;
    setPageError("");
    try {
      await api.createAccount({
        name: draftName,
        type,
        parent_id: parentId === "" ? null : parentId,
        is_overdraft: advancedOverdraft,
      });
      setName("");
      setParentId("");
      setAdvancedOverdraft(false);
      refresh();
      showToast(`계정 "${draftName}" 생성됨`);
    } catch (error) {
      setPageError((error as Error).message);
    }
  };

  const createRoot = async (rootType: AccountType) => {
    if (!rootDraft || rootDraft.type !== rootType || !rootDraft.name.trim()) return;
    const draftName = rootDraft.name.trim();
    setPageError("");
    try {
      await api.createAccount({
        name: draftName,
        type: rootType,
        parent_id: null,
        is_overdraft: rootType === "asset" && rootDraft.isOverdraft,
      });
      setRootDraft(null);
      refresh();
      showToast(`${TYPE_LABEL[rootType]} "${draftName}" 생성됨`);
    } catch (error) {
      setPageError((error as Error).message);
    }
  };

  const createChild = async (parent: Account) => {
    if (!childDraft || childDraft.parentId !== parent.id || !childDraft.name.trim()) return;
    const draftName = childDraft.name.trim();
    setPageError("");
    try {
      await api.createAccount({
        name: draftName,
        type: parent.type,
        parent_id: parent.id,
        is_overdraft: parent.type === "asset" && childDraft.isOverdraft,
      });
      setChildDraft(null);
      refresh();
      showToast(`"${parent.name}" 아래 "${draftName}" 생성됨`);
    } catch (error) {
      setPageError((error as Error).message);
    }
  };

  const seedStandard = async () => {
    setPageError("");
    try {
      const seeded = await api.seedStandardAccounts();
      refresh();
      showToast(
        seeded.created > 0
          ? `표준 계정과목 ${seeded.created}개 추가됨`
          : "표준 계정과목이 이미 모두 있습니다",
      );
    } catch (error) {
      setPageError((error as Error).message);
    }
  };

  const startSettings = (account: Account) => {
    setPageError("");
    clearRowError(account.id);
    setRootDraft(null);
    setChildDraft(null);
    setSettingsAccountId(account.id);
  };

  const returnFocusToSettings = (id: number) => {
    requestAnimationFrame(() => {
      const button = document.getElementById(`account-settings-${id}`);
      button?.scrollIntoView({ block: "nearest", inline: "nearest" });
      button?.focus();
    });
  };

  const cancelSettings = (id: number) => {
    setSettingsAccountId(null);
    returnFocusToSettings(id);
  };

  const settingsSaved = async (before: Account, result: AccountSettingsResult) => {
    setSettingsAccountId(null);
    await loadAccounts();
    refresh();

    const nameChanged = before.name !== result.account.name;
    const overdraftChanged = before.is_overdraft !== result.account.is_overdraft;
    if (result.effects.moved) {
      const parent = result.account.parent_id === null
        ? `${TYPE_LABEL[result.account.type]} 최상위`
        : accountList.find((candidate) => candidate.id === result.account.parent_id)?.name ?? "새 상위 그룹";
      const sourceNote = result.effects.source_parent_grouped
        ? " · 비어진 이전 계정은 그룹으로 유지했습니다"
        : "";
      showToast(`"${result.account.name}"을(를) "${parent}" 위치로 이동했습니다${sourceNote}`);
    } else if (nameChanged && !overdraftChanged) {
      showToast(`"${before.name}" → "${result.account.name}" 이름 변경됨`);
    } else if (!nameChanged && overdraftChanged) {
      showToast(result.account.is_overdraft ? "마이너스통장으로 설정됨" : "일반 계정으로 변경됨");
    } else {
      showToast(`"${result.account.name}" 설정을 저장했습니다`);
    }
    returnFocusToSettings(result.account.id);
  };

  const archive = async (account: Account) => {
    if (!balances || rowTasks[account.id]) return;
    const balance = balanceOf(account.id)?.balance ?? 0;
    if (balance !== 0 && !window.confirm(
      `"${account.name}"에 잔액 ${fmtWon(balance)}이 남아 있습니다.\n` +
      "회계 관습상 이체·조정으로 잔액을 비운 뒤 보관하는 것이 정석입니다.\n그래도 보관할까요?",
    )) return;

    setRowTask(account.id, "archive");
    try {
      await api.archiveAccount(account.id);
      refresh();
      showToast(`"${account.name}" 보관됨 — 아래 보관된 계정에서 복원할 수 있습니다`);
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setRowTask(account.id);
    }
  };

  const restore = async (account: Account) => {
    if (rowTasks[account.id]) return;
    setRowTask(account.id, "restore");
    try {
      await api.restoreAccount(account.id);
      refresh();
      showToast(`"${account.name}" 복원됨`);
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setRowTask(account.id);
    }
  };

  const toggleGroup = async (account: Account) => {
    setPageError("");
    try {
      await api.setPlaceholder(account.id, !account.is_placeholder);
      refresh();
      showToast(
        account.is_placeholder
          ? `"${account.name}" 일반 계정으로`
          : `"${account.name}" 그룹(대분류)으로 — 하위 계정을 만들어 쓰세요`,
      );
    } catch (error) {
      setPageError((error as Error).message);
    }
  };

  const reclassifyDirect = async (account: Account) => {
    const target = reclassTargets[account.id];
    if (target === undefined || target === "") return;
    setPageError("");
    try {
      const result = await api.reclassifyDirect(account.id, target);
      setReclassTargets((current) => ({ ...current, [account.id]: "" }));
      refresh();
      showToast(`"${account.name}" 미분류 ${result.moved_postings}건 이동됨`);
    } catch (error) {
      setPageError((error as Error).message);
    }
  };

  const recordOpening = async (
    account: Account,
    amount: number,
    state: "positive" | "negative",
  ) => {
    if (rowTasks[account.id]) return false;
    clearRowError(account.id);
    setRowTask(account.id, "opening");
    try {
      const transaction = await api.createOpeningBalance(account.id, {
        date: todayIso(),
        amount,
        state,
      });
      const record: OpeningBalanceRecord = {
        account_id: account.id,
        transaction_id: transaction.id,
        date: transaction.date,
        state,
      };
      setOpeningRecords((current) => current ? [...current, record] : [record]);
      refresh();
      showToast(`개시잔액 기록됨 · ${account.name}`, async () => {
        await api.deleteTransaction(transaction.id);
        refresh();
      });
      return true;
    } catch (error) {
      setRowErrors((current) => ({ ...current, [account.id]: (error as Error).message }));
      return false;
    } finally {
      setRowTask(account.id);
    }
  };

  const undoOpening = async (account: Account, transactionId: number) => {
    if (rowTasks[account.id]) return;
    clearRowError(account.id);
    setRowTask(account.id, "opening");
    try {
      await api.deleteTransaction(transactionId);
      setOpeningRecords((current) => current?.filter((record) => record.transaction_id !== transactionId) ?? []);
      refresh();
      showToast(`"${account.name}" 개시잔액 기록 취소됨`);
    } catch (error) {
      setRowErrors((current) => ({ ...current, [account.id]: (error as Error).message }));
    } finally {
      setRowTask(account.id);
    }
  };

  const toggleZero = (account: Account) => {
    const confirmed = zeroConfirmed.includes(account.id);
    const next = confirmed
      ? zeroConfirmed.filter((id) => id !== account.id)
      : [...zeroConfirmed, account.id];
    saveZeroConfirmed(next);
    if (!confirmed) showToast(`${account.name} — 0원으로 확인됨 (기록할 거래 없음)`);
  };

  const renderRootDraft = (sectionType: AccountType) => {
    if (rootDraft?.type !== sectionType) return null;
    return (
      <tr className="account-inline" key={`root-${sectionType}`}>
        <td>
          <input
            ref={inlineRef}
            className="compact-input"
            aria-label={`${TYPE_LABEL[sectionType]} 새 분류 이름`}
            value={rootDraft.name}
            onChange={(event) => setRootDraft({ ...rootDraft, name: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createRoot(sectionType);
              if (event.key === "Escape") setRootDraft(null);
            }}
            placeholder="이름"
          />
        </td>
        <td>
          <span className="badge">{TYPE_LABEL[sectionType]}</span>
          {sectionType === "asset" && (
            <label className="overdraft-check">
              <input
                type="checkbox"
                checked={rootDraft.isOverdraft}
                onChange={(event) => setRootDraft({ ...rootDraft, isOverdraft: event.target.checked })}
              />
              마이너스통장
            </label>
          )}
        </td>
        <td />
        <td />
        <td className="row-actions">
          <button className="btn sm primary" disabled={!rootDraft.name.trim()} onClick={() => void createRoot(sectionType)}>저장</button>
          <button className="btn sm secondary" onClick={() => setRootDraft(null)}>취소</button>
        </td>
      </tr>
    );
  };

  const renderChildDraft = (parent: Account, depth: number) => {
    if (childDraft?.parentId !== parent.id) return null;
    return (
      <tr className="account-inline" key={`child-${parent.id}`}>
        <td style={{ paddingLeft: 8 + (depth + 1) * 20 }}>
          <span className="tree-guide">└ </span>
          <input
            ref={inlineRef}
            className="compact-input"
            aria-label={`${parent.name} 소분류 이름`}
            value={childDraft.name}
            onChange={(event) => setChildDraft({ ...childDraft, name: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createChild(parent);
              if (event.key === "Escape") setChildDraft(null);
            }}
            placeholder="이름"
          />
        </td>
        <td>
          <span className="badge">{TYPE_LABEL[parent.type]}</span>
          {parent.type === "asset" && (
            <label className="overdraft-check">
              <input
                type="checkbox"
                checked={childDraft.isOverdraft}
                onChange={(event) => setChildDraft({ ...childDraft, isOverdraft: event.target.checked })}
              />
              마이너스통장
            </label>
          )}
        </td>
        <td />
        <td />
        <td className="row-actions">
          <button className="btn sm primary" disabled={!childDraft.name.trim()} onClick={() => void createChild(parent)}>저장</button>
          <button className="btn sm secondary" onClick={() => setChildDraft(null)}>취소</button>
        </td>
      </tr>
    );
  };

  const renderUnclassified = (account: Account, depth: number) => {
    if (!balances) return null;
    const raw = balanceOf(account.id)?.balance ?? 0;
    if (raw === 0) return null;
    const targets = visible.filter((candidate) => candidate.parent_id === account.id && isPostable(accountList, candidate));
    const target = reclassTargets[account.id] ?? "";
    return (
      <tr key={`unclassified-${account.id}`} className="muted-row">
        <td style={{ paddingLeft: 8 + (depth + 1) * 20 }}>
          <span className="tree-guide">└ </span>(미분류)
        </td>
        <td><span className="badge">직접 기장</span></td>
        <td className="num">{fmtWon(displayAmount(account, raw))}</td>
        <td />
        <td className="row-actions">
          <select
            className="compact-select"
            aria-label={`${account.name} 미분류 이동 대상`}
            value={target}
            disabled={targets.length === 0}
            onChange={(event) => setReclassTargets((current) => ({
              ...current,
              [account.id]: event.target.value === "" ? "" : Number(event.target.value),
            }))}
          >
            <option value="">대상</option>
            {targets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
          <button className="btn sm secondary" disabled={target === ""} onClick={() => void reclassifyDirect(account)}>
            소분류로 이동
          </button>
        </td>
      </tr>
    );
  };

  const renderBalanceCell = (account: Account, rollupIds: number[]) => {
    if (balancesError) {
      return (
        <span className="cell-error" role="alert">
          불러오지 못함
          <button className="retry-action" type="button" onClick={loadBalances}>다시 시도</button>
        </span>
      );
    }
    if (!balances) return <span className="cell-loading" aria-label="잔액 확인 중">…</span>;
    const rawSum = rollupIds.reduce((sum, id) => sum + (balanceOf(id)?.balance ?? 0), 0);
    return fmtWon(displayAmount(account, rawSum));
  };

  const renderAccountRow = (account: Account, depth: number) => {
    const isNetWorthAccount = account.type === "asset" || account.type === "liability";
    const hasChildren = accountList.some((child) => child.parent_id === account.id);
    const hasVisibleChildren = visible.some((child) => child.parent_id === account.id);
    const group = isGroup(accountList, account);
    const rollupIds = hasVisibleChildren ? withDescendants(visible, account.id) : [account.id];
    const editing = settingsAccountId === account.id;
    const pending = rowTasks[account.id];

    return (
      <Fragment key={account.id}>
        <tr className={`account-row${group ? " group-row" : ""}${editing ? " settings-open" : ""}`}>
          <td style={{ paddingLeft: 8 + depth * 20 }}>
            {depth > 0 && <span className="tree-guide">└ </span>}
            <span className="account-name" title={account.name} aria-label={account.name}>{account.name}</span>
            {group && (
              <span className="badge group-badge">{hasChildren ? "그룹 · 합산" : "그룹"}</span>
            )}
          </td>
          <td>
            <span className="badge">{TYPE_LABEL[account.type]}</span>
            {account.is_overdraft && <span className="badge account-state-badge">마이너스통장</span>}
          </td>
          <td className="num balance-cell">{renderBalanceCell(account, rollupIds)}</td>
          <td className="opening-cell">
            {isNetWorthAccount && !group ? (
              <OpeningBalanceControl
                key={`${account.id}-${account.is_overdraft}`}
                account={account}
                record={openingOf(account.id)}
                zeroConfirmed={!openingOf(account.id) && zeroConfirmed.includes(account.id)}
                readState={openingsError ? "error" : openingRecords ? "ready" : "loading"}
                disabled={Boolean(pending)}
                pending={pending === "opening"}
                error={rowErrors[account.id]}
                onChange={() => clearRowError(account.id)}
                onRetry={loadOpeningRecords}
                onRecord={(amount, state) => recordOpening(account, amount, state)}
                onZero={() => toggleZero(account)}
                onUndo={(transactionId) => undoOpening(account, transactionId)}
              />
            ) : null}
          </td>
          <td className="row-actions">
            {group && (
              <button
                className="btn sm secondary"
                disabled={Boolean(pending)}
                onClick={() => {
                  setChildDraft({ parentId: account.id, name: "", isOverdraft: false });
                  setRootDraft(null);
                  setSettingsAccountId(null);
                }}
              >
                <Plus size={13} aria-hidden="true" />
                소분류
              </button>
            )}
            {!hasChildren && !account.is_overdraft && (
              <button
                className="btn sm secondary"
                disabled={Boolean(pending)}
                onClick={() => void toggleGroup(account)}
              >
                {account.is_placeholder ? "그룹 해제" : "그룹으로"}
              </button>
            )}
            <button
              id={`account-settings-${account.id}`}
              className={`btn sm secondary${editing ? " on" : ""}`}
              disabled={Boolean(pending)}
              aria-expanded={editing}
              aria-controls={`account-settings-panel-${account.id}`}
              onClick={() => editing ? cancelSettings(account.id) : startSettings(account)}
            >
              <Settings2 size={13} aria-hidden="true" />
              설정
            </button>
            <button
              className="btn sm secondary"
              disabled={!balances || Boolean(balancesError) || Boolean(pending)}
              onClick={() => void archive(account)}
            >
              {pending === "archive" ? "보관 중…" : "보관"}
            </button>
          </td>
        </tr>
        {editing && (
          <AccountSettingsPanel
            account={account}
            accounts={accountList}
            onCancel={() => cancelSettings(account.id)}
            onSaved={(result) => settingsSaved(account, result)}
          />
        )}
      </Fragment>
    );
  };

  const renderSection = (sectionType: AccountType) => {
    const rows = accountTree(visible.filter((account) => account.type === sectionType));
    const virtualsByAfter = new Map<number, { account: Account; depth: number }[]>();
    rows.forEach(({ account, depth }, index) => {
      if (!balances || !isGroup(accountList, account) || (balanceOf(account.id)?.balance ?? 0) === 0) return;
      let last = index;
      for (let cursor = index + 1; cursor < rows.length && rows[cursor].depth > depth; cursor += 1) last = cursor;
      virtualsByAfter.set(last, [...(virtualsByAfter.get(last) ?? []), { account, depth }]);
    });

    const output = [
      <tr className="account-section" key={`section-${sectionType}`}>
        <td colSpan={5}>
          <div className="account-section-heading">
            <span>{TYPE_LABEL[sectionType]}</span>
            <button
              className="btn sm secondary"
              onClick={() => {
                closeInlineEditors();
                setRootDraft({ type: sectionType, name: "", isOverdraft: false });
              }}
            >
              <Plus size={13} aria-hidden="true" />
              새 분류
            </button>
          </div>
        </td>
      </tr>,
      renderRootDraft(sectionType),
    ];

    rows.forEach(({ account, depth }, index) => {
      output.push(renderAccountRow(account, depth));
      output.push(renderChildDraft(account, depth));
      const virtuals = (virtualsByAfter.get(index) ?? []).sort((left, right) => right.depth - left.depth);
      for (const virtual of virtuals) output.push(renderUnclassified(virtual.account, virtual.depth));
    });
    return output;
  };

  const selectedParent = parentId === "" ? undefined : accountList.find((account) => account.id === parentId);
  const advancedOverdraftEligible = type === "asset" && !selectedParent?.is_overdraft;

  return (
    <div>
      <h1>계정 · 개시잔액</h1>

      <div className="accounts-toolbar">
        <button className="btn secondary" onClick={() => void seedStandard()}>표준 계정과목 추가</button>
        {pageError && <span className="row-error" role="alert">{pageError}</span>}
      </div>

      <details className="advanced-accounts">
        <summary>고급</summary>
        <div className="advanced-fields">
          <div className="field">
            <label htmlFor="advanced-account-name">계정 이름</label>
            <input
              id="advanced-account-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="예: Toss뱅크"
              onKeyDown={(event) => event.key === "Enter" && name.trim() && void create()}
            />
          </div>
          <div className="field">
            <label htmlFor="advanced-account-type">유형</label>
            <select
              id="advanced-account-type"
              value={type}
              onChange={(event) => {
                const nextType = event.target.value as AccountType;
                setType(nextType);
                setParentId("");
                if (nextType !== "asset") setAdvancedOverdraft(false);
              }}
            >
              {DISPLAY_TYPES.map((accountType) => (
                <option key={accountType} value={accountType}>{TYPE_LABEL[accountType]}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="advanced-account-parent">상위 그룹 (선택)</label>
            <select
              id="advanced-account-parent"
              value={parentId}
              onChange={(event) => {
                const nextParent = event.target.value === "" ? "" : Number(event.target.value);
                setParentId(nextParent);
                const parent = nextParent === "" ? undefined : accountList.find((account) => account.id === nextParent);
                if (parent?.is_overdraft) setAdvancedOverdraft(false);
              }}
            >
              <option value="">없음 (최상위)</option>
              {accountTree(accountList.filter((account) => account.type === type && !account.is_system && !account.archived)).map(({ account, depth }) => (
                <option key={account.id} value={account.id} disabled={account.is_overdraft}>
                  {"  ".repeat(depth)}{account.name}
                </option>
              ))}
            </select>
          </div>
          {advancedOverdraftEligible && (
            <label className="overdraft-check advanced-overdraft">
              <input
                type="checkbox"
                aria-label={`${name.trim() || "새 계정"} 마이너스통장`}
                checked={advancedOverdraft}
                onChange={(event) => setAdvancedOverdraft(event.target.checked)}
              />
              마이너스통장
            </label>
          )}
          <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>계정 추가</button>
        </div>
      </details>

      {accountsError && (
        <div className="banner err" role="alert">
          계정을 불러오지 못했습니다. {accountsError}
          <button className="btn sm secondary" type="button" onClick={loadAccounts}>다시 시도</button>
        </div>
      )}

      {!accounts ? (
        accountsError ? null : (
          <p className="page-loading">계정 확인 중…</p>
        )
      ) : (
        <div className="accounts-ledger-wrap">
          <table className="ledger accounts-ledger">
            <thead>
              <tr>
                <th>계정</th>
                <th>종류</th>
                <th className="num">현재 잔액</th>
                <th>개시잔액</th>
                <th><span className="sr-only">계정 작업</span></th>
              </tr>
            </thead>
            <tbody>{DISPLAY_TYPES.flatMap(renderSection)}</tbody>
          </table>
        </div>
      )}

      {archivedList.length > 0 && (
        <div className="archived-accounts">
          <h2 className="section-heading">보관된 계정 ({archivedList.length})</h2>
          <div className="accounts-ledger-wrap">
            <table className="ledger archived-ledger">
              <tbody>
                {archivedList.map((account) => {
                  const pending = rowTasks[account.id];
                  return (
                    <tr key={account.id} className="muted-row">
                      <td>
                        <span className="account-name" title={account.name}>{account.name}</span>
                      </td>
                      <td>
                        <span className="badge">{TYPE_LABEL[account.type]}</span>
                        {account.is_overdraft && <span className="badge account-state-badge">마이너스통장</span>}
                      </td>
                      <td className="num">
                        {balancesError ? "불러오지 못함" : balances ? fmtWon(balanceOf(account.id)?.balance ?? 0) : "…"}
                      </td>
                      <td className="row-actions">
                        <button className="btn sm secondary" disabled={Boolean(pending)} onClick={() => void restore(account)}>
                          {pending === "restore" ? "복원 중…" : "복원"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
