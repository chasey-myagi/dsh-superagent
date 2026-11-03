#!/bin/sh
# 本地工单 prepare：按工单 target 在对应仓库开 worktree，分支 agent/<name>。在执行根目录下由 sh 运行。
set -eu
WS=${DSH_SUPERAGENT_WS:-/workspace/dsh-superagent-ws}
target=$(gh-local target "${DSH_SUPERAGENT_GITHUB_NUMBER:?}" 2>/dev/null || echo memory-explore)
repo="$WS/$target"; [ -d "$repo/.git" ] || repo="$WS/memory-explore"
base=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
git -C "$repo" worktree add -b "agent/${DSH_SUPERAGENT_NAME:?}" "${DSH_SUPERAGENT_DIR:?}" "$base"
echo "prepared $DSH_SUPERAGENT_DIR from $repo@$base"
