#!/bin/bash
# 恢复主仓工作区可写（运营 land/merge 前调用）。
set -eu
WS=${DSH_SUPERAGENT_WS:-/workspace/dsh-superagent-ws}
unlock_one() {
  local repo=$1
  [ -d "$repo/.git" ] || return 0
  git -C "$repo" ls-files -z | while IFS= read -r -d '' f; do
    [ -e "$repo/$f" ] || continue
    [ -f "$repo/$f" ] || continue
    chmod u+w "$repo/$f" 2>/dev/null || true
  done
  # sentinel may be a-w
  chmod u+w "$repo/.superagent-main-protected" 2>/dev/null || true
  rm -f "$repo/.superagent-main-protected"
  echo "unlocked $repo"
}
if [ "$#" -gt 0 ]; then
  for r in "$@"; do unlock_one "$r"; done
else
  unlock_one "$WS/memory-explore"
  unlock_one "$WS/dsh-superagent"
fi
