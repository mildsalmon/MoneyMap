import type { Account, AccountType } from "./types";


/** 계정 트리 정렬: 유형 순 → 영속 위치 순 → 자식은 부모 바로 아래 (depth 포함) */
const TYPE_ORDER: AccountType[] = ["asset", "liability", "income", "expense", "equity"];

export function accountTree(accounts: Account[]): { account: Account; depth: number }[] {
  const byParent = new Map<number | null, Account[]>();
  for (const a of accounts) {
    const key = a.parent_id ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), a]);
  }
  const out: { account: Account; depth: number }[] = [];
  const walk = (parent: number | null, depth: number, type?: AccountType) => {
    const children = (byParent.get(parent) ?? [])
      .filter((a) => !type || a.type === type)
      .sort((x, y) => x.position - y.position || x.id - y.id);
    for (const a of children) {
      out.push({ account: a, depth });
      walk(a.id, depth + 1);
    }
  };
  for (const t of TYPE_ORDER) walk(null, 0, t);
  return out;
}

/** 자식 포함 합산 잔액용: 계정 id → 자기+모든 후손 id 목록 */
export function withDescendants(accounts: Account[], id: number): number[] {
  const out = [id];
  for (const a of accounts) {
    if (a.parent_id === id) out.push(...withDescendants(accounts, a.id));
  }
  return out;
}

/** 기장 가능 계정 = 보관 안 됨 AND 그룹 아님(placeholder도, 자식도 없음) — D23·D24 */
export function postableAccountIds(accounts: Account[]): Set<number> {
  const parents = new Set(accounts.map((account) => account.parent_id));
  return new Set(accounts
    .filter((account) => !account.archived && !account.is_placeholder && !parents.has(account.id))
    .map((account) => account.id));
}

export function isPostable(accounts: Account[], account: Account): boolean {
  return postableAccountIds(accounts).has(account.id);
}

/** 그룹(대분류) 여부 = placeholder이거나 자식이 있음 */
export function isGroup(accounts: Account[], a: Account): boolean {
  return a.is_placeholder || accounts.some((c) => c.parent_id === a.id);
}
