import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Account } from "../api";
import { overlayOrder, siblings, validReorderResponse } from "./accountOrdering";
import type { AccountWrites } from "./useAccountWrites";

interface Operation {
  ticket: number;
  owner: Account;
  before: number[];
  desired: number[];
  phase: "saving" | "undoing" | "reconciling" | "refresh-required";
  rejected: boolean;
  undo: boolean;
}
interface Options {
  accounts: Account[] | null;
  applySaved: (saved: Account[]) => void;
  loadAccounts: () => Promise<Account[] | undefined>;
  writes: AccountWrites;
  blocked: (owner: Account) => boolean;
}
const same = (a: number[], b: number[]) => JSON.stringify(a) === JSON.stringify(b);
const rejectionCodes = new Set(["account_parent_stale", "account_reorder_duplicate", "account_reorder_parent_not_found", "account_reorder_account_not_found", "account_reorder_parent_forbidden", "account_reorder_parent_type_mismatch", "account_reorder_scope_mismatch", "account_reorder_set_mismatch", "account_reorder_stale", "account_reorder_forbidden", "account_position_temp_range_exhausted", "account_position_invariant", "database_busy"]);

export function useAccountOrdering(options: Options) {
  const latest = useRef(options); latest.current = options;
  const [operations, setOperations] = useState<Operation[]>([]);
  const [notice, setNotice] = useState("");
  const pendingFocus = useRef<number | null>(null);
  function update(op: Operation) {
    setOperations(current => [...current.filter(item => item.ticket !== op.ticket), op]);
  }
  function finish(op: Operation, message: string) {
    setNotice(message);
    options.writes.finish(op.ticket);
    setOperations(current => current.filter(item => item.ticket !== op.ticket));
    const focused = document.activeElement;
    if (focused === document.body || focused?.getAttribute("data-order-control") === String(op.owner.id)) {
      pendingFocus.current = op.owner.id;
    }
  }
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    const candidates = [...document.querySelectorAll<HTMLButtonElement>(`[data-order-control="${id}"]`)];
    const target = candidates.find(b => !b.matches(":disabled") && b.getClientRects().length)
      ?? document.getElementById("accounts-title");
    target?.focus(); target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    pendingFocus.current = null;
  });
  async function reconcile(op: Operation) {
    update({ ...op, phase: "reconciling" });
    const canonical = await latest.current.loadAccounts();
    if (!options.writes.holds(op.ticket)) return;
    if (!canonical) {
      update({ ...op, phase: "refresh-required" });
      return;
    }
    const ids = siblings(canonical, op.owner).map(a => a.id);
    if (!op.rejected && same(ids, op.desired)) options.writes.success(op.ticket, "현재 순서를 확인했습니다");
    finish(op, op.rejected ? (op.undo ? "다른 변경이 있어 실행 취소하지 못했습니다" : "변경하지 못했습니다. 최신 순서를 불러왔습니다")
      : same(ids, op.desired) ? "현재 순서를 확인했습니다"
      : same(ids, op.before) ? "현재 서버는 변경 전 순서입니다"
      : "다른 변경으로 순서가 달라졌습니다");
  }
  async function save(owner: Account, ids: number[], undoSnapshot?: Account[]) {
    const opts = latest.current;
    if (opts.blocked(owner) || !opts.accounts) return;
    const previous = undoSnapshot ?? siblings(opts.accounts, owner);
    const before = previous.map(a => a.id);
    if (ids.length < 2 || same(before, ids) || new Set(ids).size !== previous.length || ids.some(id => !before.includes(id))) return;
    const ticket = opts.writes.begin(owner);
    if (ticket === null) return;
    const op: Operation = { ticket, owner, before, desired: ids, phase: undoSnapshot ? "undoing" : "saving", rejected: false, undo: !!undoSnapshot };
    update(op);
    opts.writes.announce(undoSnapshot ? "실행 취소 중…" : "순서 저장 중…");
    try {
      const result = await api.reorderAccounts({ type: owner.type, parent_id: owner.parent_id,
        parent_versions: opts.writes.parentVersions(owner),
        ordered_accounts: ids.map(id => ({ id, version: previous.find(a => a.id === id)!.version })) });
      if (!opts.writes.holds(ticket)) return;
      if (!validReorderResponse(result, previous, ids)) throw new Error("잘못된 순서 응답");
      opts.applySaved(result.accounts);
      opts.writes.success(ticket, undoSnapshot ? "순서 변경을 취소했습니다" : `‘${owner.name}’ 순서 변경됨`,
        undoSnapshot ? undefined : () => save(owner, before, result.accounts));
      const parent = opts.accounts.find(a => a.id === owner.parent_id)?.name ?? "최상위";
      finish(op, `${owner.name}, ${parent} 그룹의 ${ids.indexOf(owner.id) + 1}번째 위치로 이동됨`);
    } catch (error) {
      if (!opts.writes.holds(ticket)) return;
      op.rejected = error instanceof ApiError && (error.status === 422 || rejectionCodes.has(error.code ?? ""));
      await reconcile(op);
    }
  }
  const display = operations.reduce((rows, op) => overlayOrder(rows, op.owner,
    op.rejected || op.phase === "refresh-required" ? op.before : op.desired), options.accounts ?? []);
  return { display, notice, operations, save, retry: reconcile };
}
