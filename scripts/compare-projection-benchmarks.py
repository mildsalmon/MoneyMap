"""Enforce head SQL count and same-runner service/API p95 regression budgets."""
import json
import sys
from pathlib import Path

base, head = (json.loads(Path(path).read_text()) for path in sys.argv[1:3])
assert head["sql_statements"] <= 18, head["sql_statements"]
assert head["api_sql_statements"] <= 18, head["api_sql_statements"]
for metric in ("service", "api"):
    ratio = head[metric]["p95_ms"] / base[metric]["p95_ms"]
    print(f"{metric}: base={base[metric]['p95_ms']:.1f}ms head={head[metric]['p95_ms']:.1f}ms ratio={ratio:.3f}")
    assert ratio <= 1.25, f"{metric} p95 regression exceeds 25%"
