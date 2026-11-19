import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Plus, Settings2 } from "lucide-react";
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
import { AccountRowMenu } from "./AccountRowMenu";
import { AccountHistoryLink } from "./AccountHistoryLink";
import { AccountSettingsPanel } from "./AccountSettingsPanel";
import { OpeningBalanceControl } from "./OpeningBalanceControl";
import { useAccountOrdering } from "./useAccountOrdering";
import { AccountOrderControls, AccountOrderProvider } from "./AccountOrderControls";

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
  const [mutationPending, setMutationPending] = useState(false);
  const [dragRows, setDragRows] = useState<ReadonlySet<number> | null>(null);
  const dragging = dragRows !== null;
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());
  function setGroupFolded(id: number, fold: boolean) {
    setFolded(previous => {
      const next = new Set(previous);
      if (fold) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  const [settingsFocusId, setSettingsFocusId] = useState<number | null>(null);
  const [menuFocusId, setMenuFocusId] = useState<number | null>(null);
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
      const result = await api.accounts(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
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

  const ordering = useAccountOrdering({ accounts, setAccounts, loadAccounts,
    cancelRead: () => accountRequest.current?.abort(), showToast,
    blocked: mutationPending || Object.values(rowTasks).some(Boolean) || !!rootDraft || !!childDraft || settingsAccountId !== null || !!name.trim(),
  });
  const accountList = ordering.display;
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
    if (!draftName || mutationPending || ordering.locked || dragging) return;
    setMutationPending(true);
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
    } finally {
      setMutationPending(false);
    }
  };

  const createRoot = async (rootType: AccountType) => {
    if (!rootDraft || rootDraft.type !== rootType || !rootDraft.name.trim()) return;
    if (mutationPending || ordering.locked || dragging) return;
    setMutationPending(true);
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
    } finally {
      setMutationPending(false);
    }
  };

  const createChild = async (parent: Account) => {
    if (!childDraft || childDraft.parentId !== parent.id || !childDraft.name.trim()) return;
    if (mutationPending || ordering.locked || dragging) return;
    setMutationPending(true);
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
    } finally {
      setMutationPending(false);
    }
  };

  const seedStandard = async () => {
    if (mutationPending || ordering.locked || dragging) return;
    setMutationPending(true);
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
    } finally {
      setMutationPending(false);
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
    setSettingsFocusId(id);
  };

  useEffect(() => {
    if (settingsFocusId === null || mutationPending || settingsAccountId !== null) return;
    const button = document.getElementById(`account-settings-${settingsFocusId}`);
    if (!button || button.matches(":disabled")) return;
    button.scrollIntoView({ block: "nearest", inline: "nearest" });
    button.focus();
    setSettingsFocusId(null);
  }, [settingsFocusId, mutationPending, settingsAccountId, accounts]);

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

  const [removedRow, setRemovedRow] = useState<{ source: string; next?: string } | null>(null);

  function focusAfterRemoval(id: number, archived: boolean) {
    const prefix = archived ? "account-restore-" : "account-settings-";
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(`button[id^="${prefix}"]`));
    const source = prefix + id;
    const index = buttons.findIndex(button => button.id === source);
    setRemovedRow({ source, next: index >= 0 ? buttons[index + 1]?.id : undefined });
  }

  useEffect(() => {
    if (!removedRow || document.getElementById(removedRow.source)) return;
    const next = removedRow.next && document.getElementById(removedRow.next);
    (next || document.getElementById("accounts-title"))?.focus();
    setRemovedRow(null);
  }, [accounts, removedRow]);

  useLayoutEffect(() => {
    if (menuFocusId === null) return;
    // Disabling the fieldset during the request blurs its trigger. Respect focus
    // if the user moved elsewhere before the request finished.
    if (document.activeElement === document.body) {
      document.getElementById(`account-row-menu-${menuFocusId}-trigger`)?.focus();
    }
    setMenuFocusId(null);
  }, [menuFocusId]);

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
      focusAfterRemoval(account.id, false);
      refresh();
      showToast(`"${account.name}" 보관됨 — 아래 보관된 계정에서 복원할 수 있습니다`);
    } catch (error) {
      setPageError((error as Error).message);
      setMenuFocusId(account.id);
    } finally {
      setRowTask(account.id);
    }
  };

  const restore = async (account: Account) => {
    if (rowTasks[account.id]) return;
    setRowTask(account.id, "restore");
    try {
      await api.restoreAccount(account.id);
      focusAfterRemoval(account.id, true);
      refresh();
      showToast(`"${account.name}" 복원됨`);
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setRowTask(account.id);
    }
  };

  const toggleGroup = async (account: Account) => {
    if (mutationPending || ordering.locked || dragging) return;
    setMutationPending(true);
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
    } finally {
      setMutationPending(false);
      setMenuFocusId(account.id);
    }
  };

  const reclassifyDirect = async (account: Account) => {
    const target = reclassTargets[account.id];
    if (target === undefined || target === "") return;
    if (mutationPending || ordering.locked || dragging) return;
    setMutationPending(true);
    setPageError("");
    try {
      const result = await api.reclassifyDirect(account.id, target);
      setReclassTargets((current) => ({ ...current, [account.id]: "" }));
      refresh();
      showToast(`"${account.name}" 미분류 ${result.moved_postings}건 이동됨`);
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setMutationPending(false);
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
      <tr key={`unclassified-${account.id}`} className="muted-row" data-order-row={account.id} data-drag-member={dragRows?.has(account.id) || undefined}>
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
    const cashLeaves = withDescendants(accountList, account.id).slice(1)
      .map((id) => accountList.find((item) => item.id === id)!)
      .filter((item) => item.type === "asset" && !item.archived && !item.is_system && !isGroup(accountList, item));
    const editing = settingsAccountId === account.id;
    const pending = rowTasks[account.id];

    return (
      <Fragment key={account.id}>
        <tr data-order-row={account.id} data-drag-member={dragRows?.has(account.id) || undefined} className={`account-row${group ? " group-row" : ""}${editing ? " settings-open" : ""}`}>
          <td className="order-name-cell" style={{ paddingLeft: 8 + depth * 20 }}>
            <div className="order-account-label">
            <AccountOrderControls account={account} />
            {depth > 0 && <span className="tree-guide">└ </span>}
            <AccountHistoryLink accountId={account.id} className="account-name">{account.name}</AccountHistoryLink>
            {hasVisibleChildren ? (
              <button type="button" className="badge group-badge group-disclosure"
                aria-expanded={!folded.has(account.id)}
                aria-label={`${account.name} 하위 계정 ${folded.has(account.id) ? "펼치기" : "접기"}`}
                disabled={settingsAccountId !== null || childDraft !== null}
                onClick={() => setGroupFolded(account.id, !folded.has(account.id))}>
                {folded.has(account.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                그룹 · 합산
              </button>
            ) : group && <span className="badge group-badge">{hasChildren ? "그룹 · 합산" : "그룹"}</span>}
            {ordering.operation?.owner.id === account.id && <small className="order-row-status">{ordering.operation.phase === "saving" ? "순서 저장 중…" : ordering.operation.phase === "undoing" ? "실행 취소 중…" : "순서 확인 중…"}</small>}
            </div>
          </td>
          <td>
            <span className="badge">{TYPE_LABEL[account.type]}</span>
            {account.is_overdraft && <span className="badge account-state-badge">마이너스통장</span>}
            {account.include_in_cash && <span className="badge account-state-badge">현금성</span>}
            {group && account.type === "asset" && <span className="badge account-state-badge">하위 {cashLeaves.length}개 중 {cashLeaves.filter((item) => item.include_in_cash).length}개 포함</span>}
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
            <AccountRowMenu id={account.id} name={account.name} actions={[
              ...(group ? [{ label: "소분류", run: () => {
                setGroupFolded(account.id, false);
                setChildDraft({ parentId: account.id, name: "", isOverdraft: false });
                setRootDraft(null);
                setSettingsAccountId(null);
              } }] : []),
              ...(!hasChildren && !account.is_overdraft ? [{
                label: account.is_placeholder ? "그룹 해제" : "그룹으로",
                run: () => void toggleGroup(account),
              }] : []),
              { label: `${account.name} 보관`, disabled: !balances || Boolean(balancesError),
                run: () => void archive(account) },
            ]} />
          </td>
        </tr>
        {editing && (
          <AccountSettingsPanel
            account={account}
            accounts={accountList}
            onPendingChange={setMutationPending}
            onCancel={() => cancelSettings(account.id)}
            onSaved={(result) => settingsSaved(account, result)}
          />
        )}
      </Fragment>
    );
  };

  const renderSection = (sectionType: AccountType) => {
    let foldedDepth = Infinity;
    const rows = accountTree(visible.filter(account => account.type === sectionType)).filter(({ account, depth }) => {
      if (depth > foldedDepth) return false;
      foldedDepth = folded.has(account.id) ? depth : Infinity;
      return true;
    });
    const virtualsByAfter = new Map<number, { account: Account; depth: number }[]>();
    rows.forEach(({ account, depth }, index) => {
      if (folded.has(account.id) || !balances || !isGroup(accountList, account) || (balanceOf(account.id)?.balance ?? 0) === 0) return;
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
    <AccountOrderProvider accounts={accountList} save={ordering.save} onDragging={setDragRows}
      disabled={ordering.locked || mutationPending || Object.values(rowTasks).some(Boolean) || !!rootDraft || !!childDraft || settingsAccountId !== null || !!name.trim()}>
    <div>
      <h1 id="accounts-title" tabIndex={-1}>계정 · 개시잔액</h1>
      {ordering.notice && <div className="banner order-status" role="status">
        {ordering.notice}
        {ordering.operation?.phase === "refresh-required" && <button type="button" className="btn sm secondary" onClick={() => void ordering.retry()}>다시 불러오기</button>}
      </div>}
      <fieldset className="account-mutation-fields" disabled={ordering.locked || dragging || mutationPending || Object.values(rowTasks).some(Boolean)}>

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
                        <AccountHistoryLink accountId={account.id} className="account-name">{account.name}</AccountHistoryLink>
                      </td>
                      <td>
                        <span className="badge">{TYPE_LABEL[account.type]}</span>
                        {account.is_overdraft && <span className="badge account-state-badge">마이너스통장</span>}
                      </td>
                      <td className="num">
                        {balancesError ? "불러오지 못함" : balances ? fmtWon(balanceOf(account.id)?.balance ?? 0) : "…"}
                      </td>
                      <td className="row-actions">
                        <button id={`account-restore-${account.id}`} className="btn sm secondary" disabled={Boolean(pending)} onClick={() => void restore(account)}>
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
      </fieldset>
    </div>
    </AccountOrderProvider>
  );
}
