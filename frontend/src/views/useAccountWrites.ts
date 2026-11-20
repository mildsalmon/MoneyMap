import { useEffect, useReducer, useRef } from "react";
import type { Account } from "../api";
import type { ViewProps } from "../App";

export type SiblingScope = Pick<Account, "type" | "parent_id">;

function parentPath(accounts: Account[], scope: SiblingScope) {
  const path = new Set<number | null>([null]);
  let parent = scope.parent_id;
  while (parent !== null && !path.has(parent)) {
    path.add(parent);
    parent = accounts.find(a => a.id === parent)?.parent_id ?? null;
  }
  return path;
}

export function scopesOverlap(accounts: Account[], a: SiblingScope, b: SiblingScope) {
  return a.type === b.type && (parentPath(accounts, a).has(b.parent_id) || parentPath(accounts, b).has(a.parent_id));
}

// Acquire synchronously before dispatch, including both ends of a move.
// A ticket belongs to this visit and remains held through reconciliation.
export function useAccountWrites(accounts: Account[], blocked: boolean, showToast: ViewProps["showToast"]) {
  const active = useRef(new Map<number, { scopes: SiblingScope[]; writeOrder: number }>());
  const sequence = useRef(0);
  const lastSuccess = useRef(0);
  const [, render] = useReducer(n => n + 1, 0);
  useEffect(() => () => {
    active.current.clear();
    lastSuccess.current = 0;
  }, []);
  function busy(...scopes: SiblingScope[]) {
    return blocked || [...active.current.values()].some(held =>
      held.scopes.some(a => scopes.some(b => scopesOverlap(accounts, a, b))));
  }
  // A confirmation needs its own scope lock but keeps the order of the write it checks.
  function confirm(writeOrder: number, ...scopes: SiblingScope[]) {
    if (busy(...scopes)) return null;
    const ticket = ++sequence.current;
    active.current.set(ticket, { scopes, writeOrder });
    render();
    return ticket;
  }
  function markNewWrite(ticket: number) {
    const lock = active.current.get(ticket);
    if (lock) lock.writeOrder = ticket;
  }
  function begin(...scopes: SiblingScope[]) {
    const ticket = confirm(0, ...scopes);
    if (ticket !== null) markNewWrite(ticket);
    return ticket;
  }
  function finish(ticket: number) {
    if (active.current.delete(ticket)) render();
  }
  function success(ticket: number, message: string, undo?: () => Promise<void>) {
    const lock = active.current.get(ticket);
    if (!lock || lock.writeOrder < lastSuccess.current) return;
    const order = lock.writeOrder;
    lastSuccess.current = order;
    showToast(message, undo && (async () => {
      if (lastSuccess.current === order) await undo();
    }));
  }
  function parentVersions(...scopes: SiblingScope[]) {
    const parents = new Set(scopes.flatMap(scope => [...parentPath(accounts, scope)]));
    return Object.fromEntries(accounts.filter(a => parents.has(a.id)).map(a => [a.id, a.version]));
  }
  function announce(message: string) {
    if (!lastSuccess.current) showToast(message);
  }
  return { begin, confirm, markNewWrite, busy, finish, success, announce, parentVersions, holds: (ticket: number) => active.current.has(ticket),
    pending: active.current.size > 0 };
}

export type AccountWrites = ReturnType<typeof useAccountWrites>;
