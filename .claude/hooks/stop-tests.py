#!/usr/bin/env python3
"""Stop hook: the session cannot end while the fast suite is red.

Three ways to write this hook so that it silently does nothing, all handled below:

  1. `stop_hook_active` MUST exit 0. If it does not, the session can never end —
     the hook blocks, the model tries to stop, the hook blocks again, forever.
  2. Exit 2 blocks. Exit 1 is SILENTLY IGNORED. A gate that exits 1 on failure
     is a gate that does nothing, and it looks like it is working.
  3. Claude Code kills the hook at 60s. Gate the FAST suite only. A slow gate
     gets disabled, and a disabled gate is worse than none because everyone
     believes it is still on.

stderr on exit 2 is fed back into the model's context, so this echoes the RAW
failure rather than a summary. Why: a summary is what lets a red run get
narrated as amber.

BACKSTOP (added after this hook trapped itself in testing): reading
`stop_hook_active` from stdin is not reliable on every platform, and a hook that
depends on it for its only escape can lock a session forever. So the block count
is also persisted to disk and capped. Why: the cost of a gate that fails open
once is a red commit; the cost of a gate that traps the agent is the entire
window. These are not symmetric, so the backstop wins ties.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COUNTER = ROOT / ".claude" / ".stop-block-count"
MAX_CONSECUTIVE_BLOCKS = 2  # matches "three honest attempts, then stop"


def read_payload() -> dict:
    """Tolerate an empty, BOM-prefixed, or unparseable stdin."""
    try:
        raw = sys.stdin.read()
    except Exception:
        return {}
    if not raw:
        return {}
    raw = raw.lstrip("﻿").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def blocks_so_far() -> int:
    try:
        return int(COUNTER.read_text().strip() or "0")
    except Exception:
        return 0


def set_blocks(n: int) -> None:
    try:
        COUNTER.parent.mkdir(parents=True, exist_ok=True)
        if n <= 0:
            COUNTER.unlink(missing_ok=True)
        else:
            COUNTER.write_text(str(n))
    except Exception:
        pass  # never let bookkeeping failure change the verdict


def main() -> int:
    payload = read_payload()

    # (1) Re-entered after a block — let the session end.
    if payload.get("stop_hook_active"):
        set_blocks(0)
        return 0

    # Operator asked for a clean stop: finish the turn, write the handover, stop.
    # Never trap the agent — a run that dies with its findings in context loses them all.
    if (ROOT / "STOP").exists():
        set_blocks(0)
        return 0

    # Escape hatch for a wedged session.
    if os.environ.get("SKIP_STOP_GATE") == "1":
        set_blocks(0)
        return 0

    # BACKSTOP: never block more than MAX_CONSECUTIVE_BLOCKS times in a row.
    already = blocks_so_far()
    if already >= MAX_CONSECUTIVE_BLOCKS:
        set_blocks(0)
        print(
            f"verify is still RED after {already} blocks. Letting the session end rather "
            "than grinding. Record the item as passes:false with a diagnosis in BLOCKED.md.",
            file=sys.stderr,
        )
        return 0

    try:
        result = subprocess.run(
            ["npm", "run", "--silent", "verify"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=55,  # (3) under Claude Code's 60s kill
            shell=(sys.platform == "win32"),
        )
    except subprocess.TimeoutExpired:
        set_blocks(already + 1)
        print(
            "verify exceeded 55s. The gate covers the FAST suite only — move the slow "
            "checks out of `npm run verify` rather than widening this timeout.",
            file=sys.stderr,
        )
        return 2  # (2) exit 2 blocks

    if result.returncode != 0:
        set_blocks(already + 1)
        # Raw output, both streams, no summarising.
        print(result.stdout or "", file=sys.stderr)
        print(result.stderr or "", file=sys.stderr)
        print(
            "\nverify is RED. Fix it, or mark the item passes:false with a diagnosis "
            "in BLOCKED.md and move on. Three honest attempts, then stop — do not grind.",
            file=sys.stderr,
        )
        return 2

    set_blocks(0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
