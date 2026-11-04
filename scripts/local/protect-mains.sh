#!/bin/bash
# 将主仓（或参数给定路径）已跟踪工作区文件设为只读，防止 worker 误写（D18）。
set -eu
WS=${DSH_SUPERAGENT_WS:-/workspace/dsh-superagent-ws}
protect_one() {
  local repo=$1
  [ -d "$repo/.git" ] || return 0
  git -C "$repo" ls-files -z | while IFS= read -r -d '' f; do
    [ -e "$repo/$f" ] || continue
    [ -f "$repo/$f" ] || continue
    chmod a-w "$repo/$f" 2>/dev/null || true
  done
  printf 'protected=1\n' >"$repo/.superagent-main-protected"
  chmod a-w "$repo/.superagent-main-protected" 2>/dev/null || true
  echo "protected $repo"
}
if [ "$#" -gt 0 ]; then
  for r in "$@"; do protect_one "$r"; done
else
  protect_one "$WS/memory-explore"
  protect_one "$WS/dsh-superagent"
fi
