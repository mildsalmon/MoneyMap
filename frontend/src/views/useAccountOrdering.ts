import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, ApiError, type Account } from "../api";
import type { ViewProps } from "../App";
import { overlayOrder, siblings, validReorderResponse } from "./accountOrdering";

interface Operation { owner: Account; before: number[]; desired: number[]; phase: "saving" | "undoing" | "reconciling" | "refresh-required"; rejected: boolean; undo: boolean }
interface Options {
  accounts: Account[] | null;
  setAccounts: Dispatch<SetStateAction<Account[] | null>>;
  loadAccounts: () => Promise<Account[] | undefined>;
  cancelRead: () => void;
  blocked: boolean;
  showToast: ViewProps["showToast"];
}
const same = (a: number[], b: number[]) => JSON.stringify(a) === JSON.stringify(b);
const rejectionCodes = new Set(["account_reorder_duplicate", "account_reorder_parent_not_found", "account_reorder_account_not_found", "account_reorder_parent_forbidden", "account_reorder_parent_type_mismatch", "account_reorder_scope_mismatch", "account_reorder_set_mismatch", "account_reorder_stale", "account_reorder_forbidden", "account_position_temp_range_exhausted", "account_position_invariant", "database_busy"]);

export function useAccountOrdering(options: Options) {
  const latest = useRef(options); latest.current = options;
  const [operation, setOperation] = useState<Operation | null>(null);
  const active = useRef<Operation | null>(null);
  const visit = useRef(0), token = useRef(0);
  const [notice, setNotice] = useState("");
  const pendingFocus = useRef<{ id: number; visit: number } | null>(null);
  useEffect(() => { visit.current++; return () => { visit.current++; token.current++; }; }, []);
  const publish = (op: Operation | null) => { active.current = op; setOperation(op); };
  const focus = (id: number, version: number) => { pendingFocus.current = { id, visit: version }; };
  // Wait for the committed DOM: optimistic position changes and fieldset unlock
  // can otherwise move focus onto a button that becomes disabled a frame later.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || operation || visit.current !== pending.visit) return;
    const candidates = [...document.querySelectorAll<HTMLButtonElement>(`[data-order-control="${pending.id}"]`)];
    const target = candidates.find(b => !b.matches(":disabled") && b.getClientRects().length)
      ?? document.getElementById("accounts-title");
    target?.focus(); target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    pendingFocus.current = null;
  });
  async function reconcile(op: Operation, expectedToken: number, expectedVisit: number) {
    if (visit.current !== expectedVisit || token.current !== expectedToken) return;
    publish({ ...op, phase: "reconciling" });
    setNotice("저장 결과를 확인하고 있습니다…");
    const canonical = await latest.current.loadAccounts();
    if (visit.current !== expectedVisit || token.current !== expectedToken) return;
    if (!canonical) {
      publish({ ...op, phase: "refresh-required" });
      setNotice(op.rejected ? "최신 순서를 불러오지 못했습니다" : "순서 확인 필요");
      return;
    }
    const ids = siblings(canonical, op.owner).map(a => a.id);
    setNotice(op.rejected ? (op.undo ? "다른 변경이 있어 실행 취소하지 못했습니다" : "변경하지 못했습니다. 최신 순서를 불러왔습니다")
      : same(ids, op.desired) ? "현재 순서를 확인했습니다"
      : same(ids, op.before) ? "현재 서버는 변경 전 순서입니다"
      : "다른 변경으로 순서가 달라졌습니다");
    publish(null); focus(op.owner.id, expectedVisit);
  }
  async function save(owner: Account, ids: number[], undoSnapshot?: Account[]) {
    const opts = latest.current;
    if (active.current || opts.blocked || !opts.accounts) return;
    const previous = undoSnapshot ?? siblings(opts.accounts, owner);
    const before = previous.map(a => a.id);
    if (ids.length < 2 || same(before, ids) || new Set(ids).size !== previous.length || ids.some(id => !before.includes(id))) return;
    const thisToken = ++token.current, thisVisit = visit.current;
    const op: Operation = { owner, before, desired: ids, phase: undoSnapshot ? "undoing" : "saving", rejected: false, undo: !!undoSnapshot };
    opts.cancelRead(); publish(op); setNotice(undoSnapshot ? "실행 취소 중…" : "순서 저장 중…");
    // idle → saving/undoing → success | reconciling → refresh-required
    // Writes outlive route visits; visit/token guards suppress departed UI callbacks.
    opts.showToast(undoSnapshot ? "실행 취소 중…" : "순서 저장 중…");
    try {
      const result = await api.reorderAccounts({ type: owner.type, parent_id: owner.parent_id,
        ordered_accounts: ids.map(id => ({ id, version: previous.find(a => a.id === id)!.version })) });
      if (thisVisit !== visit.current || thisToken !== token.current) return;
      if (!validReorderResponse(result, previous, ids)) throw new Error("잘못된 순서 응답");
      opts.cancelRead();
      opts.setAccounts(current => (current ?? []).map(a => result.accounts.find(saved => saved.id === a.id) ?? a));
      publish(null);
      const parent = opts.accounts.find(a => a.id === owner.parent_id)?.name ?? "최상위";
      setNotice(`${owner.name}, ${parent} 그룹의 ${ids.indexOf(owner.id) + 1}번째 위치로 이동됨`);
      focus(owner.id, thisVisit);
      opts.showToast(undoSnapshot ? "순서 변경을 취소했습니다" : `‘${owner.name}’ 순서 변경됨`, undoSnapshot ? undefined : async () => {
        if (thisVisit === visit.current && thisToken === token.current) await save(owner, before, result.accounts);
      });
    } catch (error) {
      if (thisVisit !== visit.current || thisToken !== token.current) return;
      op.rejected = error instanceof ApiError && (error.status === 422 || rejectionCodes.has(error.code ?? ""));
      await reconcile(op, thisToken, thisVisit);
    }
  }
  const display = operation ? overlayOrder(options.accounts ?? [], operation.owner,
    operation.rejected || operation.phase === "refresh-required" ? operation.before : operation.desired) : options.accounts ?? [];
  return { display, locked: !!operation, notice, operation, save,
    retry: async () => { const op = active.current; if (op?.phase === "refresh-required") await reconcile(op, token.current, visit.current); } };
}
