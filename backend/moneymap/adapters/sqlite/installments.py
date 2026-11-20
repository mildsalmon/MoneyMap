"""Installment aggregate: purchase -> principal rows <- actual payment/refund.

One IMMEDIATE transaction owns validation, writes, revision and retry receipt.
Read models batch allocations; projections use settlements at their fork date.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from collections import defaultdict

from moneymap.app_services.scenarios import now
from moneymap.domain import Money, Posting, Transaction
from moneymap.domain.errors import (
    DomainConflictError,
    DomainNotFoundError,
    DomainValidationError,
)

from moneymap.domain.installments import row_balances
from moneymap.domain.projection import ProjectionEvent
from moneymap.domain.services import validate_postable_accounts
from .account_history import posting_accounts_on
from .accounts import SqliteAccountRepository
from .common import _account_write
from .transactions import _insert_txn


def revision(conn):
    return conn.execute(
        "SELECT installment_revision FROM calculation_revisions WHERE id=1"
    ).fetchone()[0]


def mutate(conn, command, action, target, apply):
    body = command.model_dump(mode="json")
    # Commands issued before v15 must still match their durable receipt.
    if action == "create" and command.statement is None:
        for key in ("statement", "statement_date", "interest_account_id", "fee_account_id"):
            body.pop(key)
    if action == "allocate":
        for row in body["allocations"]:
            for key in ("interest", "fee"):
                if row[f"{key}_charge_id"] is None:
                    row.pop(f"{key}_charge_id")
                if row[key] == 0:
                    row.pop(key)
    payload = json.dumps([action, target, body], sort_keys=True)
    fingerprint = hashlib.sha256(payload.encode()).hexdigest()
    with _account_write(conn):
        receipt = conn.execute(
            "SELECT * FROM installment_requests WHERE request_id=?",
            (str(command.request_id),),
        ).fetchone()
        if receipt:
            if receipt["fingerprint"] != fingerprint:
                raise DomainConflictError(
                    "재시도 내용이 달라졌습니다. 최신 목록을 확인하세요",
                    code="installment_request_conflict",
                )
            return json.loads(receipt["result"])
        if revision(conn) != command.expected_revision:
            raise DomainConflictError(
                "할부 내역이 변경됐습니다. 최신 목록을 확인한 뒤 다시 저장하세요",
                code="installment_revision_conflict",
            )
        result = apply() or {}
        conn.execute(
            "UPDATE calculation_revisions SET installment_revision=installment_revision+1 WHERE id=1"
        )
        result["revision"] = revision(conn)
        result["request_id"] = str(command.request_id)
        conn.execute(
            "INSERT INTO installment_requests VALUES(?,?,?)",
            (str(command.request_id), fingerprint, json.dumps(result)),
        )
        return result


def _require_plan(conn, plan_id):
    row = conn.execute(
        "SELECT p.*,t.date purchase_date FROM installment_plans p JOIN transactions t ON t.id=p.purchase_id WHERE p.id=?",
        (plan_id,),
    ).fetchone()
    if row is None:
        raise DomainNotFoundError("할부 일정이 없습니다", code="installment_not_found")
    return row


def create(conn, command):
    def apply():
        if command.statement_date and command.statement_date > now().date():
            raise DomainValidationError("명세서 기준일은 오늘 또는 과거여야 합니다")
        if command.date > now().date():
            raise DomainValidationError("구매일은 오늘 또는 과거여야 합니다")
        by_id = posting_accounts_on(conn, command.date, {command.debit_account_id, command.card_account_id})
        # The plan also commits future payments to this card and cash account.
        # Preserve their separate current-lifecycle checks.
        accounts = SqliteAccountRepository(conn).find_all()
        schedule_ids = {command.card_account_id, command.cash_account_id}
        cost_ids = {command.interest_account_id, command.fee_account_id} - {None}
        schedule_ids.update(cost_ids)
        validate_postable_accounts(accounts, list(schedule_ids))
        for account in accounts:
            if account.id in schedule_ids:
                if account.archived or account.is_system:
                    raise DomainValidationError("납부에 사용할 수 있는 통장과 카드를 선택하세요")
                if account.id in cost_ids and account.type.value != "expense":
                    raise DomainValidationError("이자와 수수료는 비용 계정을 선택하세요")
                by_id[account.id] = account
        if any(account.currency != "KRW" for account in by_id.values()):
            raise DomainValidationError("사용 가능한 원화 말단 계정을 선택하세요")
        if (
            by_id[command.card_account_id].type.value != "liability"
            or by_id[command.cash_account_id].type.value != "asset"
            or by_id[command.debit_account_id].type.value not in {"asset", "expense"}
        ):
            raise DomainValidationError(
                "구매는 비용/자산, 카드는 부채, 납부 통장은 자산 계정을 선택하세요"
            )
        if command.debit_account_id == command.cash_account_id:
            raise DomainValidationError(
                "구매 자산과 납부 통장은 다른 계정을 선택하세요"
            )
        txn = Transaction(
            scenario_id=1,
            date=command.date,
            description=command.description.strip(),
            postings=[
                Posting(
                    account_id=command.debit_account_id,
                    amount=Money(amount=command.principal),
                ),
                Posting(
                    account_id=command.card_account_id,
                    amount=Money(amount=-command.principal),
                ),
            ],
        )
        purchase_id = _insert_txn(conn, txn)
        plan_id = conn.execute(
            "INSERT INTO installment_plans(purchase_id,debit_account_id,card_account_id,cash_account_id,principal,exclude_from_spend,interest_account_id,fee_account_id) VALUES(?,?,?,?,?,?,?,?)",
            (
                purchase_id,
                command.debit_account_id,
                command.card_account_id,
                command.cash_account_id,
                command.principal,
                int(command.exclude_from_spend), command.interest_account_id, command.fee_account_id,
            ),
        ).lastrowid
        for row in command.rows():
            row_id = conn.execute(
                "INSERT INTO installments(plan_id,number,due_date,principal) VALUES(?,?,?,?)",
                (plan_id, row["number"], row["due_date"], row["principal"]),
            ).lastrowid
            if command.statement is not None:
                conn.execute(
                    "INSERT INTO installment_statements VALUES(?,?,?,?,0,0)",
                    (row_id, (command.statement_date or command.date).isoformat(), row["interest"], row["fee"]),
                )
        return {"id": plan_id, "purchase_id": purchase_id}

    return mutate(conn, command, "create", None, apply)


def rule_context(plan, rules, rows):
    # Any cash->same card rule in the schedule window could include this purchase.
    # Include rules from other cash accounts: card bills may move between banks.
    remaining = [r for r in rows if r["unpaid_total"] > 0]
    candidates = [
        r
        for r in rules
        if r.to_account_id == plan["card_account_id"]
        and remaining
        and r.start_date.isoformat() <= max(x["due_date"] for x in remaining)
        and (
            r.end_date is None
            or r.end_date.isoformat() >= min(x["due_date"] for x in remaining)
        )
    ]
    serialized = [
        r.model_dump(mode="json", exclude={"last_materialized"}) for r in candidates
    ]
    signature = hashlib.sha256(
        json.dumps(serialized, sort_keys=True).encode()
    ).hexdigest()
    return candidates, signature


def statement_costs(entry):
    return {key: entry[key] if entry is not None else 0
            for key in ("interest", "fee", "cancelled_interest", "early_fee")}


def read_plans(conn, as_of=None):
    """Batch reads independent of the number of purchases."""
    as_of = as_of or now().date()
    plans = [
        dict(r)
        for r in conn.execute(
            "SELECT p.*,t.description,t.date purchase_date FROM installment_plans p JOIN transactions t ON t.id=p.purchase_id ORDER BY p.id DESC"
        )
    ]
    if not plans:
        return []
    day = as_of.isoformat()
    statements = {}
    for entry in conn.execute("SELECT * FROM installment_statements WHERE effective_date<=? ORDER BY effective_date", (day,)):
        statements[entry["installment_id"]] = entry
    allocations = defaultdict(list)
    for entry in conn.execute(
        """SELECT a.*,t.date,t.description FROM installment_allocations a
           JOIN transactions t ON t.id=a.transaction_id WHERE t.date<=? ORDER BY t.date,t.id""", (day,)
    ):
        allocations[entry["installment_id"]].append(dict(entry))
    by_plan = defaultdict(list)
    cost_plans = {p["id"] for p in plans if p["interest_account_id"]}
    for source in conn.execute("SELECT * FROM installments ORDER BY plan_id,number"):
        row = dict(source)
        statement = statement_costs(statements.get(row["id"]))
        if row["plan_id"] in cost_plans and row["id"] not in statements:
            statement.update(interest=None, fee=None)
        row.update(row_balances(row["principal"], statement, allocations[row["id"]]))
        row["unknown_cost"] = row["interest"] is None or row["fee"] is None
        row["status"] = ("paid" if not row["unpaid_total"] and not row["unknown_cost"]
                         else "needs_confirmation" if row["due_date"] <= day else "scheduled")
        by_plan[row["plan_id"]].append(row)
    for p in plans:
        p["installments"] = by_plan[p["id"]]
        p["allocations"] = [a for r in p["installments"] for a in allocations[r["id"]]]
        p["remaining_principal"] = sum(r["remaining"] for r in p["installments"])
        p["unpaid_total"] = sum(r["unpaid_total"] for r in p["installments"])
        outstanding = [r for r in p["installments"] if r["status"] != "paid"]
        p["next_due_date"] = min((r["due_date"] for r in outstanding), default=None)
        p["completion_date"] = max((r["due_date"] for r in outstanding), default=None)
    return plans


def bill_capacity(rules, day, cash, card):
    return sum(
        r.amount.amount for r in rules
        if r.from_account_id == cash and r.to_account_id == card
        and r.start_date <= day <= (r.end_date or day)
        and next(r.schedule.occurrences(day, day), None) is not None
    )


def uncovered_plans(plans, rules):
    """Included installments must fit the bills on the same date and bank/card pair.

    Sum across purchases before comparing: one 200k bill cannot cover two 200k
    installments just because each purchase separately fits that bill.
    """
    groups = {}
    for p in plans:
        if p["projection_mode"] != "included":
            continue
        for row in p["installments"]:
            if row["unpaid_total"]:
                key = (row["due_date"], p["cash_account_id"], p["card_account_id"])
                group = groups.setdefault(key, {"amount": 0, "ids": set()})
                group["amount"] += row["unpaid_total"]
                group["ids"].add(p["id"])
    uncovered = set()
    for (date, cash, card), group in groups.items():
        day = dt.date.fromisoformat(date)
        capacity = bill_capacity(rules, day, cash, card)
        if capacity < group["amount"]:
            uncovered.update(group["ids"])
    return uncovered


def list_plans(conn):
    from .rules import ScenarioRuleWriter

    rules = ScenarioRuleWriter(conn).find_by_scenario(1)
    plans = read_plans(conn)
    uncovered = uncovered_plans(plans, rules)
    for p in plans:
        candidates, signature = rule_context(p, rules, p["installments"])
        p["current_rule_signature"] = signature
        p["conflicting_rules"] = [
            {"id": r.id, "description": r.description, "amount": r.amount.amount}
            for r in candidates
        ]
        p["needs_projection_decision"] = bool(candidates) and (
            p["projection_mode"] == "pending" or signature != p["rule_signature"]
        )
        if p["id"] in uncovered or (
            p["projection_mode"] == "included"
            and not candidates
            and p["unpaid_total"]
        ):
            p["needs_projection_decision"] = True
    return {
        "revision": revision(conn),
        "as_of": now().date().isoformat(),
        "plans": plans,
    }


def validate_row_history(conn, row_id):
    """Replacements and unlinks must leave every historical day consistent."""
    principal = conn.execute("SELECT principal FROM installments WHERE id=?", (row_id,)).fetchone()[0]
    entries = conn.execute(
        """SELECT a.*,t.date FROM installment_allocations a JOIN transactions t ON t.id=a.transaction_id
           WHERE a.installment_id=? ORDER BY t.date,t.id""", (row_id,),
    ).fetchall()
    statements = {row["effective_date"]: row for row in conn.execute(
        "SELECT * FROM installment_statements WHERE installment_id=?", (row_id,)
    )}
    by_day = defaultdict(list)
    by_txn = {a["transaction_id"]: a for a in entries}
    drawn = defaultdict(int)
    for a in entries:
        by_day[a["date"]].append(a)
        for component in ("interest", "fee"):
            charge_id = a[f"{component}_charge_id"]
            if charge_id is None:
                continue
            charge = by_txn.get(charge_id)
            if charge is None or charge["kind"] != "charge" or charge["date"] > a["date"]:
                raise DomainValidationError("같은 회차에 먼저 연결한 비용 분개를 선택하세요")
            key = (charge_id, component)
            drawn[key] += a[component]
            if drawn[key] > charge[component]:
                raise DomainValidationError("선기장 거래의 비용 배분액을 넘습니다")
    statement = None
    seen = []
    for day in sorted(statements.keys() | by_day.keys()):
        statement = statements.get(day, statement)
        seen.extend(by_day[day])
        row_balances(principal, statement_costs(statement), seen)


def update_statement(conn, row_id, command):
    def apply():
        row = conn.execute("""SELECT p.interest_account_id,t.date FROM installments i
            JOIN installment_plans p ON p.id=i.plan_id JOIN transactions t ON t.id=p.purchase_id
            WHERE i.id=?""", (row_id,)).fetchone()
        if row is None:
            raise DomainNotFoundError("회차가 없습니다", code="installment_not_found")
        if not row["interest_account_id"]:
            raise DomainValidationError("명세서 방식의 회차에서 비용을 변경할 수 있습니다")
        day = command.effective_date.isoformat()
        if day < row["date"] or command.effective_date > now().date():
            raise DomainValidationError("명세서 기준일은 구매일부터 오늘 사이여야 합니다")
        conn.execute("""INSERT INTO installment_statements VALUES(?,?,?,?,?,?)
            ON CONFLICT(installment_id,effective_date) DO UPDATE SET interest=excluded.interest,
            fee=excluded.fee,cancelled_interest=excluded.cancelled_interest,early_fee=excluded.early_fee""",
            (row_id, day, command.interest, command.fee, command.cancelled_interest, command.early_fee))
        validate_row_history(conn, row_id)

    return mutate(conn, command, "statement", row_id, apply)


def allocation_postings(kind, allocation, plan, amounts):
    """Yield the actual debit/credit pairs supporting each component."""
    card, cash = plan["card_account_id"], plan["cash_account_id"]
    if allocation.amount:
        if kind not in ("payment", "billed_payment", "refund"):
            raise DomainValidationError("비용 연결에는 원금을 배분할 수 없습니다")
        yield card, plan["debit_account_id"] if kind == "refund" else cash, allocation.amount
    for component in ("interest", "fee"):
        value = getattr(allocation, component)
        charge_id = getattr(allocation, f"{component}_charge_id")
        if charge_id and (not value or kind not in ("billed_payment", "charge_refund")):
            raise DomainValidationError("선기장 비용 납부 또는 미납 청구 환급에 원래 비용 분개를 연결하세요")
        if value and kind == "charge_refund" and not charge_id:
            raise DomainValidationError("환급할 선기장 비용 분개를 선택하세요")
        if not value:
            continue
        expense = plan[f"{component}_account_id"]
        if not expense or kind == "refund":
            raise DomainValidationError("비용 배분은 명세서의 납부 또는 비용 환급으로 연결하세요")
        if kind == "payment":
            yield expense, cash, value
        elif kind == "charge":
            yield expense, card, value
        elif kind == "billed_payment":
            yield card if charge_id else expense, cash, value
        elif kind == "charge_refund":
            yield card, expense, value
        else:  # A paid expense can be refunded to the card or its payment account.
            yield cash if amounts.get(cash, 0) > 0 else card, expense, value


def allocate(conn, command):
    def apply():
        txn = conn.execute(
            "SELECT * FROM transactions WHERE id=? AND scenario_id=1 AND posted=1",
            (command.transaction_id,),
        ).fetchone()
        if txn is None:
            raise DomainNotFoundError(
                "실제 납부/환불 거래가 없습니다", code="transaction_not_found"
            )
        if txn["date"] > now().date().isoformat():
            raise DomainValidationError("미래 거래를 실제 납부로 확인할 수 없습니다")
        if conn.execute(
            "SELECT 1 FROM installment_plans WHERE purchase_id=?",
            (command.transaction_id,),
        ).fetchone():
            raise DomainValidationError(
                "구매 거래 자체를 납부/환불로 배분할 수 없습니다"
            )
        postings = conn.execute(
            "SELECT account_id,amount,currency FROM postings WHERE txn_id=?",
            (command.transaction_id,),
        ).fetchall()
        if any(p["currency"] != "KRW" for p in postings):
            raise DomainValidationError("원화 거래만 연결할 수 있습니다")
        amounts = {}
        for p in postings:
            amounts[p["account_id"]] = amounts.get(p["account_id"], 0) + p["amount"]
        touched = {r[0] for r in conn.execute(
            "SELECT installment_id FROM installment_allocations WHERE transaction_id=?", (command.transaction_id,)
        )}
        conn.execute(
            "DELETE FROM installment_allocations WHERE transaction_id=?",
            (command.transaction_id,),
        )
        used_debit, used_credit = {}, {}
        for allocation in command.allocations:
            row = conn.execute(
                "SELECT i.*,p.card_account_id,p.cash_account_id,p.debit_account_id,p.interest_account_id,p.fee_account_id,t.date purchase_date FROM installments i JOIN installment_plans p ON p.id=i.plan_id JOIN transactions t ON t.id=p.purchase_id WHERE i.id=?",
                (allocation.installment_id,),
            ).fetchone()
            if row is None:
                raise DomainNotFoundError(
                    "회차가 없습니다", code="installment_not_found"
                )
            if txn["date"] < row["purchase_date"]:
                raise DomainValidationError("구매일 이전 거래는 연결할 수 없습니다")
            for debit, credit, value in allocation_postings(command.kind, allocation, row, amounts):
                used_debit[debit] = used_debit.get(debit, 0) + value
                used_credit[credit] = used_credit.get(credit, 0) + value
                if used_debit[debit] > amounts.get(debit, 0) or used_credit[credit] > -amounts.get(credit, 0):
                    raise DomainValidationError("배분 합계가 거래의 해당 차변 또는 대변 금액을 넘습니다")
            for charge_id in {allocation.interest_charge_id, allocation.fee_charge_id} - {None}:
                if not conn.execute("SELECT 1 FROM transactions WHERE id=?", (charge_id,)).fetchone():
                    raise DomainValidationError("선기장 비용 거래가 없습니다")
            conn.execute(
                """INSERT INTO installment_allocations(transaction_id,installment_id,kind,amount,interest,fee,interest_charge_id,fee_charge_id)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (command.transaction_id, allocation.installment_id, command.kind, allocation.amount,
                 allocation.interest, allocation.fee, allocation.interest_charge_id, allocation.fee_charge_id),
            )
            touched.add(allocation.installment_id)
        for row_id in touched:
            validate_row_history(conn, row_id)
        return {"transaction_id": command.transaction_id}

    return mutate(conn, command, "allocate", command.transaction_id, apply)


def update_plan(conn, plan_id, command):
    def apply():
        from .rules import ScenarioRuleWriter

        plans = read_plans(conn)
        plan = next((p for p in plans if p["id"] == plan_id), None)
        if plan is None:
            raise DomainNotFoundError(
                "할부 일정이 없습니다", code="installment_not_found"
            )
        rules = ScenarioRuleWriter(conn).find_by_scenario(1)
        candidates, signature = rule_context(plan, rules, plan["installments"])
        if signature != command.rule_signature:
            raise DomainConflictError(
                "반복 규칙이 변경됐습니다. 목록을 새로 확인하세요",
                code="installment_rules_changed",
            )
        if command.projection_mode == "included" and not candidates:
            raise DomainValidationError("포함할 카드 납부 반복 규칙이 없습니다")
        plan["projection_mode"] = command.projection_mode
        if plan_id in uncovered_plans(plans, rules):
            raise DomainValidationError(
                "반복 규칙의 납부일·통장·금액이 할부 잔액을 모두 포함하지 않습니다. 예정일과 규칙을 확인하세요"
            )
        conn.execute(
            "UPDATE installment_plans SET projection_mode=?,rule_signature=? WHERE id=?",
            (command.projection_mode, signature, plan_id),
        )

    return mutate(conn, command, "update", plan_id, apply)


def reschedule(conn, row_id, command):
    def apply():
        row = conn.execute(
            "SELECT i.*,t.date purchase_date FROM installments i JOIN installment_plans p ON p.id=i.plan_id JOIN transactions t ON t.id=p.purchase_id WHERE i.id=?",
            (row_id,),
        ).fetchone()
        if row is None:
            raise DomainNotFoundError("회차가 없습니다", code="installment_not_found")
        if conn.execute(
            "SELECT 1 FROM installment_allocations WHERE installment_id=?", (row_id,)
        ).fetchone():
            raise DomainConflictError(
                "납부/환불 연결이 있는 회차입니다. 배분을 해제한 뒤 날짜를 조정하세요"
            )
        if command.due_date.isoformat() < row["purchase_date"]:
            raise DomainValidationError("납부 예정일은 구매일 이후여야 합니다")
        conn.execute(
            "UPDATE installments SET due_date=? WHERE id=?",
            (command.due_date.isoformat(), row_id),
        )
        # A date change may change which bills cover this purchase.
        conn.execute(
            "UPDATE installment_plans SET projection_mode='pending',rule_signature='' WHERE id=?",
            (row["plan_id"],),
        )

    return mutate(conn, command, "reschedule", row_id, apply)


def remove(conn, plan_id, command):
    def apply():
        _require_plan(conn, plan_id)
        if conn.execute(
            "SELECT 1 FROM installment_allocations a JOIN installments i ON i.id=a.installment_id WHERE i.plan_id=?",
            (plan_id,),
        ).fetchone():
            raise DomainConflictError(
                "납부/환불 배분을 모두 해제한 뒤 일정을 삭제하세요"
            )
        conn.execute("DELETE FROM installment_plans WHERE id=?", (plan_id,))

    return mutate(conn, command, "remove", plan_id, apply)


def _covered_payment(postings, rules, capacity, due, plan, remaining):
    if not rules or not plan["interest_account_id"] or plan["projection_mode"] == "included":
        return postings
    cash, card = plan["cash_account_id"], plan["card_account_id"]
    key = (due, cash, card)
    if key not in capacity:
        capacity[key] = bill_capacity(rules, due, cash, card)
    covered = min(remaining, capacity[key])
    capacity[key] -= covered
    return (*postings, (cash, covered), (card, -covered)) if covered else postings


def projection_inputs(conn, fork, rules, scenario_rules=(), *, ancestor_rules=()):
    events, warnings = [], []
    scenario_capacity = {}
    ancestor_capacity = {}
    # Purchases outside the opening balance must not consume historical bill capacity.
    plans = [
        p for p in read_plans(conn, fork) if p["purchase_date"] <= fork.isoformat()
    ]
    uncovered = uncovered_plans(plans, rules)
    for p in plans:
        rows = p["installments"]
        candidates, signature = rule_context(p, rules, rows)
        undecided = bool(candidates) and (
            p["projection_mode"] == "pending" or signature != p["rule_signature"]
        )
        if p["id"] in uncovered or (
            p["projection_mode"] == "included" and not candidates
        ):
            undecided = True
        if undecided and p["unpaid_total"]:
            warnings.append(
                f"{p['description']}: 카드값 반복 규칙과 중복 여부를 확인해야 합니다. 할부 예정액은 전망에서 보류했습니다."
            )
        for row in rows:
            if row["unknown_cost"]:
                warnings.append(f"{p['description']} {row['number']}회차: 미확인 이자·수수료는 전망에서 빠져 있습니다.")
            remaining = row["unpaid_total"]
            if not remaining:
                continue
            if row["due_date"] <= fork.isoformat():
                warnings.append(
                    f"{p['description']} {row['number']}회차: 납부 확인 또는 예정일 조정이 필요합니다. 현금 전망에 미확인 금액이 빠져 있습니다."
                )
                continue
            if undecided:
                continue
            # An included bill already pays cash into the card. Reclassify only
            # unbooked costs from that card repayment to their expense accounts.
            postings = []
            if p["projection_mode"] != "included":
                postings.extend([(p["cash_account_id"], -remaining), (p["card_account_id"], remaining)])
            for component in ("interest", "fee"):
                value = row[f"unbooked_{component}"]
                if value:
                    postings.extend([(p["card_account_id"], -value), (p[f"{component}_account_id"], value)])
            if not postings:
                continue
            due = dt.date.fromisoformat(row["due_date"])
            # Both curves include the parent's rules. The child may cover more
            # of this bill, so allocate capacity independently on each curve.
            baseline = _covered_payment(tuple(postings), ancestor_rules, ancestor_capacity, due, p, remaining)
            candidate = _covered_payment(tuple(postings), scenario_rules, scenario_capacity, due, p, remaining)
            events.append(
                ProjectionEvent(
                    due,
                    "installment",
                    row["id"],
                    f"{p['description']} {row['number']}회차",
                    "actual",
                    baseline,
                    scenario_postings=candidate if candidate != baseline else None,
                )
            )
    return tuple(events), tuple(dict.fromkeys(warnings))


def candidates(conn, query):
    """User searches existing actual transactions; IDs are never guessed by amount."""
    rows = conn.execute(
        "SELECT t.id,t.date,t.description,p.account_id,p.amount FROM (SELECT * FROM transactions WHERE scenario_id=1 AND posted=1 AND date<=? AND (instr(description,?)>0 OR CAST(id AS TEXT)=?) ORDER BY date DESC,id DESC LIMIT 100) t JOIN postings p ON p.txn_id=t.id ORDER BY t.date DESC,t.id DESC,p.id",
        (now().date().isoformat(), query, query),
    ).fetchall()
    result = {}
    for row in rows:
        item = result.setdefault(
            row["id"],
            {
                "id": row["id"],
                "date": row["date"],
                "description": row["description"],
                "postings": [],
            },
        )
        item["postings"].append(
            {"account_id": row["account_id"], "amount": row["amount"]}
        )
    return list(result.values())
