#!/usr/bin/env python3
"""
estimate_tokens.py - roughly estimate token counts for AGENTS.md or any text file,
then report advisory size bands.

Usage:
    # Check each file separately
    python estimate_tokens.py <file1> [file2 ...]

    # Sum files actually loaded together for a representative task,
    # including parent instructions and automatic imports.
    python estimate_tokens.py --sum <file1> <file2> ...

    # Override thresholds. CLI values take precedence over file comments/defaults.
    python estimate_tokens.py --good 2250 --ok 4250 AGENTS.md

Current estimator: total characters / 2.2 ~= tokens.
This is a rough heuristic. It tends to be workable for mixed English/code text,
may overestimate pure English, and may underestimate pure CJK text.

Use a model-appropriate tokenizer when precise counts matter.

Default advisory size bands:
    <= 2000 tokens  -> Compact
    <= 4000 tokens  -> Moderate
    >  4000 tokens  -> Review relevance and loading cost

Threshold priority: command-line --good/--ok > AGENTS.md token-thresholds comment > defaults.
Optional configuration comment:

    <!-- token-thresholds: good=2250 ok=4250 -->

Include reference files in a sum when they actually load for the task. Assess
size alongside relevance, loading behavior, and lookup cost.
"""

import argparse
import re
import sys
from pathlib import Path

CHARS_PER_TOKEN = 2.2
DEFAULT_THRESHOLD_GOOD = 2000
DEFAULT_THRESHOLD_OK = 4000

THRESHOLD_COMMENT_RE = re.compile(
    r"<!--\s*token-thresholds:\s*good=(\d+)\s+ok=(\d+)\s*-->"
)


def estimate_tokens(text: str) -> int:
    """Roughly estimate token count. Swap this implementation for more precision."""
    return round(len(text) / CHARS_PER_TOKEN)


def find_custom_thresholds(text: str):
    """Find machine-readable threshold comments in file text, if present."""
    m = THRESHOLD_COMMENT_RE.search(text)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None


def classify(tokens: int, good: int, ok: int) -> str:
    if tokens <= good:
        return "Compact"
    if tokens <= ok:
        return "Moderate"
    return "Review relevance and loading cost"


def resolve_thresholds(text: str, cli_good, cli_ok):
    """Return the effective (good, ok, source description) thresholds."""
    if cli_good is not None or cli_ok is not None:
        good = cli_good if cli_good is not None else DEFAULT_THRESHOLD_GOOD
        ok = cli_ok if cli_ok is not None else DEFAULT_THRESHOLD_OK
        return good, ok, "command-line arguments"
    custom = find_custom_thresholds(text)
    if custom:
        return custom[0], custom[1], "AGENTS.md token-thresholds comment"
    return DEFAULT_THRESHOLD_GOOD, DEFAULT_THRESHOLD_OK, "defaults"


def read_texts(paths: list[Path]) -> list[tuple[Path, str]]:
    result = []
    for path in paths:
        if not path.is_file():
            print(f"Skipping missing file: {path}", file=sys.stderr)
            continue
        result.append((path, path.read_text(encoding="utf-8", errors="replace")))
    return result


def report_individual(paths: list[Path], cli_good, cli_ok) -> None:
    for path, text in read_texts(paths):
        chars = len(text)
        lines = text.count("\n") + 1
        tokens = estimate_tokens(text)
        good, ok, source = resolve_thresholds(text, cli_good, cli_ok)
        grade = classify(tokens, good, ok)
        print(f"{path}")
        print(f"  Lines: {lines}")
        print(f"  Characters: {chars}")
        print(f"  Estimated tokens: {tokens}  (characters / {CHARS_PER_TOKEN})")
        print(f"  Advisory bands: Compact<={good} Moderate<={ok} (source: {source})")
        print(f"  Size band: {grade}")
        if tokens > ok:
            print("  Review relevance, actual loading, and lookup cost before reorganizing.")
        print()


def report_sum(paths: list[Path], cli_good, cli_ok) -> None:
    texts = read_texts(paths)
    if not texts:
        return
    total_chars = sum(len(t) for _, t in texts)
    total_tokens = estimate_tokens("x" * total_chars)
    # Threshold source follows the first file, normally AGENTS.md.
    good, ok, source = resolve_thresholds(texts[0][1], cli_good, cli_ok)
    grade = classify(total_tokens, good, ok)
    print("Summed estimate (only represents task context if these files load together)")
    for path, text in texts:
        print(f"  - {path}: {len(text)} characters / about {estimate_tokens(text)} tokens")
    print(f"Total characters: {total_chars}")
    print(f"Estimated total tokens: {total_tokens}")
    print(f"Advisory bands: Compact<={good} Moderate<={ok} (source: {source})")
    print(f"Size band: {grade}")
    print("Size is advisory: weigh relevance, loading behavior, and lookup cost before reorganizing.")
    print()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Roughly estimate token counts and report advisory size bands."
    )
    parser.add_argument("files", nargs="+", help="files to check")
    parser.add_argument("--sum", action="store_true", help="sum all file tokens together instead of reporting separately")
    parser.add_argument("--good", type=int, default=None, help='upper bound of the advisory Compact band in estimated tokens')
    parser.add_argument("--ok", type=int, default=None, help='upper bound of the advisory Moderate band in estimated tokens')
    args = parser.parse_args(argv)

    paths = [Path(p) for p in args.files]
    if args.sum:
        report_sum(paths, args.good, args.ok)
    else:
        report_individual(paths, args.good, args.ok)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
