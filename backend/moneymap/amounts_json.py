"""Lossless minor units for JavaScript readers of legacy numeric posting data."""

MAX_SAFE_INTEGER = 2**53 - 1


def preserve_posting_precision(transaction: dict) -> None:
    for posting in transaction["postings"]:
        minor = posting["amount"]["amount"]
        if abs(minor) > MAX_SAFE_INTEGER:
            posting["exact_minor"] = str(minor)
