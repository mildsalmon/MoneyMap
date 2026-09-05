"""Pure daily-close projections. Expand each assumption once, share every fold."""

from __future__ import annotations

import calendar
import datetime as dt
from dataclasses import dataclass
from itertools import groupby

from moneymap.domain.scenario import Scenario
from moneymap.domain.recurring_rule import RecurringRule


def add_months(day: dt.date, months: int) -> dt.date:
    year, month = divmod(day.year * 12 + day.month - 1 + months, 12)
    month += 1
    return dt.date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


class EffectiveRuleResolver:
    @staticmethod
    def resolve(
        scenario: Scenario, actual: list[RecurringRule], owned: list[RecurringRule]
    ) -> list[dict]:
        if scenario.is_actual:
            return [{"rule": r, "origin": "actual", "editable": False} for r in actual]
        inherited = (
            []
            if scenario.rule_mode == "legacy_snapshot"
            else [{"rule": r, "origin": "actual", "editable": False} for r in actual]
        )
        return inherited + [
            {
                "rule": r,
                "origin": "scenario",
                "editable": scenario.status == "active"
                and scenario.rule_mode == "live_additive",
            }
            for r in owned
        ]


@dataclass(frozen=True)
class ProjectionEvent:
    date: dt.date
    kind: str
    id: int
    label: str
    origin: str
    postings: tuple[tuple[int, int], ...]


class ScenarioSnapshot(Scenario):
    model_config = {"frozen": True}


class RuleSnapshot(RecurringRule):
    model_config = {"frozen": True}


@dataclass(frozen=True)
class ProjectionInputs:
    scenario: Scenario
    actual_ledger_revision: int
    actual_rule_revision: int
    account_types: tuple[tuple[int, str], ...]
    start_balances: tuple[tuple[int, int], ...]
    actual_rules: tuple[RecurringRule, ...]
    owned_rules: tuple[RecurringRule, ...]
    planned: tuple[ProjectionEvent, ...]
    cash_account_ids: tuple[int, ...] = ()
    cash_config_revision: int = 1

    def __post_init__(self):
        # Copy model values so mutation of a caller's entities cannot alter this snapshot.
        # Actual projections carry a calculation-only fork date on the system scenario.
        object.__setattr__(
            self, "scenario", ScenarioSnapshot.model_construct(**self.scenario.__dict__)
        )
        for field in ("actual_rules", "owned_rules"):
            object.__setattr__(
                self,
                field,
                tuple(
                    RuleSnapshot.model_validate(rule.model_dump())
                    for rule in getattr(self, field)
                ),
            )


def expand_events(
    inputs: ProjectionInputs, start: dt.date, end: dt.date
) -> tuple[ProjectionEvent, ...]:
    events = []
    # Actual events are shared by the baseline and live scenario, never expanded twice.
    for origin, rules in (
        ("actual", inputs.actual_rules),
        ("scenario", inputs.owned_rules),
    ):
        for rule in rules:
            for day in rule.schedule.occurrences(
                max(start, rule.start_date), min(end, rule.end_date or end)
            ):
                events.append(
                    ProjectionEvent(
                        day,
                        "rule",
                        rule.id,
                        rule.description,
                        origin,
                        (
                            (rule.from_account_id, -rule.amount.amount),
                            (rule.to_account_id, rule.amount.amount),
                        ),
                    )
                )
    events.extend(event for event in inputs.planned if start <= event.date <= end)
    return tuple(
        sorted(
            events,
            key=lambda event: (event.date, 0 if event.kind == "rule" else 1, event.id),
        )
    )


def cash_shortage(points: list[dict], triggers: dict[str, list[dict]]) -> dict | None:
    """Diagnose daily closes; equal minima retain the earliest date."""
    first = next((i for i, point in enumerate(points) if point["balance"] < 0), None)
    if first is None:
        return None
    opening = points[first]
    start = dt.date.fromisoformat(opening["date"])
    recovery = next(
        (point for point in points[first + 1 :] if point["balance"] >= 0), None
    )
    end = (
        dt.date.fromisoformat(recovery["date"]) - dt.timedelta(days=1)
        if recovery
        else None
    )
    horizon = dt.date.fromisoformat(points[-1]["date"])
    interval = {
        "start": start.isoformat(),
        "end": end.isoformat() if end else None,
        "days": ((end or horizon) - start).days + 1,
        "through_horizon": recovery is None,
        "triggering_items": triggers.get(opening["date"], []) if first else [],
    }
    if first == 0:
        interval["reason"] = "negative_start_balance"
    minimum = min(points, key=lambda point: point["balance"])
    return {"first_shortage": interval, "maximum_shortage": dict(minimum)}


def fold_projection(inputs: ProjectionInputs, months: int) -> dict:
    fork = inputs.scenario.fork_date
    assert fork is not None
    start, end = fork + dt.timedelta(days=1), add_months(fork, months)
    types = dict(inputs.account_types)

    def net(postings):
        return sum(
            amount
            for account, amount in postings
            if types[account] in {"asset", "liability"}
        )

    opening = net(inputs.start_balances)
    balances = {"baseline": opening, "scenario": opening}
    curves = {key: [{"date": fork.isoformat(), "balance": opening}] for key in balances}
    cash_ids = set(inputs.cash_account_ids)
    cash_opening = sum(
        amount for account, amount in inputs.start_balances if account in cash_ids
    )
    cash_balances = {key: cash_opening for key in balances}
    cash_curves = {
        key: [{"date": fork.isoformat(), "balance": cash_opening}] for key in balances
    }
    cash_triggers = {key: {} for key in balances}
    monthly = {}
    month = fork.replace(day=1)
    while month <= end:
        if add_months(month, 1) > start:
            monthly[month.strftime("%Y-%m")] = {
                key: {"income": 0, "expense": 0} for key in balances
            }
        month = add_months(month, 1)
    events = expand_events(inputs, start, end)
    effective = EffectiveRuleResolver.resolve(
        inputs.scenario, list(inputs.actual_rules), list(inputs.owned_rules)
    )
    scenario_rules = {item["rule"].id for item in effective}
    for day, items in groupby(events, key=lambda event: event.date):
        delta = {"baseline": 0, "scenario": 0}
        cash_delta = {key: 0 for key in balances}
        day_triggers = {key: [] for key in balances}
        for event in items:
            targets = ["baseline"] if event.origin == "actual" else []
            if event.kind == "planned_transaction" or event.id in scenario_rules:
                targets.append("scenario")
            for target in targets:
                delta[target] += net(event.postings)
                cash_delta[target] += sum(
                    amount for account, amount in event.postings if account in cash_ids
                )
                day_triggers[target].append(
                    {"kind": event.kind, "id": event.id, "label": event.label}
                )
                for account, amount in event.postings:
                    kind = types[account]
                    if kind in {"income", "expense"}:
                        monthly[day.strftime("%Y-%m")][target][kind] += (
                            -amount if kind == "income" else amount
                        )
        for target in balances:
            if cash_delta[target]:
                cash_balances[target] += cash_delta[target]
                cash_curves[target].append(
                    {"date": day.isoformat(), "balance": cash_balances[target]}
                )
                cash_triggers[target][day.isoformat()] = day_triggers[target]
            if delta[target]:
                balances[target] += delta[target]
                curves[target].append(
                    {"date": day.isoformat(), "balance": balances[target]}
                )
    for target in balances:
        if cash_curves[target][-1]["date"] != end.isoformat():
            cash_curves[target].append(
                {"date": end.isoformat(), "balance": cash_balances[target]}
            )
        if curves[target][-1]["date"] != end.isoformat():
            curves[target].append(
                {"date": end.isoformat(), "balance": balances[target]}
            )
    return {
        "fork_date": fork.isoformat(),
        "projection_start": start.isoformat(),
        "projection_end": end.isoformat(),
        "months": months,
        "basis": {
            "scenario_version": inputs.scenario.version,
            "actual_ledger_revision": inputs.actual_ledger_revision,
            "actual_rule_revision": inputs.actual_rule_revision,
            "cash_config_revision": inputs.cash_config_revision,
        },
        "capabilities": {"scenario_liquidity": True},
        "cash": {
            "available": True,
            **{
                key: {
                    "points": points,
                    "shortage": cash_shortage(points, cash_triggers[key]),
                }
                for key, points in cash_curves.items()
            },
        }
        if cash_ids
        else {"available": False, "reason": "cash_accounts_not_configured"},
        "net_worth": {key: {"points": points} for key, points in curves.items()},
        "monthly_income_expense": [
            {"month": month, **values} for month, values in monthly.items()
        ],
        "has_assumptions": bool(inputs.owned_rules or inputs.planned),
    }
