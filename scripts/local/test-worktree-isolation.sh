#!/bin/bash
# 证明 D18：gh-local 不再把主仓绝对路径当作可写目标；protect 后主仓不可写；worktree 可写。
set -eu
WS=${DSH_SUPERAGENT_WS:-/workspace/dsh-superagent-ws}
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
export PATH="$ROOT/scripts/local:$PATH"
export GH_LOCAL_HOME=${GH_LOCAL_HOME:-/tmp/gh-local-isolation-test}
rm -rf "$GH_LOCAL_HOME"; mkdir -p "$GH_LOCAL_HOME"

out=$(gh-local new "iso-test" "body-only" --target memory-explore)
n=$(echo "$out" | sed -n 's/^#\([0-9][0-9]*\).*/\1/p')
text=$(gh-local show "$n")
echo "$text" | grep -q '目标仓库：memory-explore' || { echo "FAIL: missing target label"; exit 1; }
echo "$text" | grep -q '禁止写主仓' || { echo "FAIL: missing forbid-main note"; exit 1; }
if echo "$text" | grep -qE '目标仓库：/workspace/'; then
  echo "FAIL: absolute main path still presented as 目标仓库"; exit 1
fi

bash "$ROOT/scripts/local/protect-mains.sh" "$WS/memory-explore"
if test -w "$WS/memory-explore/README.md"; then
  echo "FAIL: main README still writable after protect"; exit 1
fi
if (echo leak >"$WS/memory-explore/README.md") 2>/tmp/iso-write.err; then
  echo "FAIL: wrote main README while protected"; exit 1
fi

wt=$(ls -d /home/box/.dsh/state/superagent/work/* 2>/dev/null | head -1 || true)
if [ -n "${wt:-}" ]; then
  echo ok >"$wt/.isolation-write-test"
  rm -f "$wt/.isolation-write-test"
fi
bash "$ROOT/scripts/local/unlock-mains.sh" "$WS/memory-explore" >/dev/null
echo "PASS: worktree isolation checks"
