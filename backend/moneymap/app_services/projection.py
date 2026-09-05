"""Projection orchestration over an immutable, snapshot-consistent input port."""

from moneymap.domain.projection import fold_projection
from .scenarios import now


def build_projection(reader, scenario_id: int, months: int):
    inputs = reader.read(scenario_id)
    return {"as_of": now().isoformat(), **fold_projection(inputs, months)}


def legacy_projection(reader, sid: int, months: int):
    """Preserve unconverted snapshots on the existing dashboard only."""
    from moneymap.domain.account import AccountType
    from moneymap.domain.projection import add_months, EffectiveRuleResolver
    from moneymap.domain.simulation import project_net_worth, variable_monthly_spend

    today = now().date()
    scenario, types, opening, actual, owned, rules = reader.legacy_inputs(sid, today)
    types = {key: AccountType(value) for key, value in types.items()}
    effective = EffectiveRuleResolver.resolve(scenario, [], rules)
    points = project_net_worth(
        start_net_worth=opening,
        start=scenario.fork_date,
        end=add_months(today, months),
        rules=[item["rule"] for item in effective],
        account_types=types,
        monthly_variable_spend=variable_monthly_spend(actual, types, window_end=today),
        transactions=[txn for txn in owned if txn.source_rule_id is None],
    )
    return {
        "id": sid,
        "name": scenario.name,
        "kind": "scenario",
        "points": [
            {"date": day.isoformat(), "net_worth": amount} for day, amount in points
        ],
    }


def build_dashboard_projection(reader, scenarios, ids: list[int], months: int):
    baseline = build_projection(reader, 1, months)

    def points(curve):
        return [{"date": p["date"], "net_worth": p["balance"]} for p in curve["points"]]

    series = [
        {
            "id": "actual",
            "name": "실제",
            "kind": "actual",
            "points": reader.actual_history(baseline["fork_date"]),
        },
        {
            "id": "baseline",
            "name": "현재 패턴 유지",
            "kind": "baseline",
            "points": points(baseline["net_worth"]["baseline"]),
        },
    ]
    for sid in dict.fromkeys(ids):
        scenario = scenarios.find_by_id(sid)
        if scenario and not scenario.is_actual and scenario.status == "active":
            if scenario.rule_mode == "legacy_snapshot":
                series.append(legacy_projection(reader, sid, months))
            else:
                result = build_projection(reader, sid, months)
                series.append(
                    {
                        "id": sid,
                        "name": scenario.name,
                        "kind": "scenario",
                        "points": points(result["net_worth"]["scenario"]),
                    }
                )
    return {"series": series}
