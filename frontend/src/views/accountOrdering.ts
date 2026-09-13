import { accountTree } from "../api/accountTree";
import type { Account, AccountReorderResult } from "../api/types";

export const scopeKey = (a: Pick<Account, "type" | "parent_id">) => `${a.type}:${a.parent_id ?? "root"}`;
export function siblings(accounts: Account[], owner: Account) {
  return accounts.filter(a => !a.archived && !a.is_system && scopeKey(a) === scopeKey(owner))
    .sort((a, b) => a.position - b.position || a.id - b.id);
}
export function swapOrder(ids: number[], id: number, direction: number): number[] {
  const index = ids.indexOf(id), target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
export function insertOrder(ids: number[], source: number, target: number, after: boolean): number[] {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return ids;
  const next = ids.filter(id => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}
export function overlayOrder(accounts: Account[], owner: Account, ids: number[]) {
  const slots = siblings(accounts, owner).map(a => a.position);
  const positions = new Map(ids.map((id, i) => [id, slots[i]]));
  return accounts.map(a => positions.has(a.id) ? { ...a, position: positions.get(a.id)! } : a);
}
export interface ReorderBlock { owner: Account; rowIds: number[] }
export function projectBlocks(accounts: Account[], owner: Account): ReorderBlock[] {
  // A group owns its entire subtree only within the active sibling scope.
  // Virtual rows carry their group's id and are included when measuring rowIds.
  const tree = accountTree(accounts.filter(a => !a.archived && !a.is_system));
  return siblings(accounts, owner).map(sibling => {
    const start = tree.findIndex(row => row.account.id === sibling.id);
    if (start < 0) throw new Error("계정 트리를 확인할 수 없습니다");
    let end = start + 1;
    while (end < tree.length && tree[end].depth > tree[start].depth) end++;
    return { owner: sibling, rowIds: tree.slice(start, end).map(row => row.account.id) };
  });
}
export function validReorderResponse(result: AccountReorderResult, previous: Account[], ids: number[]) {
  if (!result || !Array.isArray(result.accounts) || !Array.isArray(result.effects?.changed_account_ids)
    || result.accounts.length !== ids.length) return false;
  const old = new Map(previous.map(a => [a.id, a]));
  const slots = [...previous].sort((a, b) => a.position - b.position).map(a => a.position);
  const changed: number[] = [];
  const valid = result.accounts.every((a, i) => {
    const before = old.get(a.id);
    if (!before || a.id !== ids[i]) return false;
    const moved = before.position !== slots[i];
    if (moved) changed.push(a.id);
    return a.position === slots[i] && a.version === before.version + Number(moved)
      && Object.keys(before).every(key => key === "position" || key === "version"
        || a[key as keyof Account] === before[key as keyof Account]);
  });
  return valid && JSON.stringify(changed) === JSON.stringify(result.effects.changed_account_ids);
}
