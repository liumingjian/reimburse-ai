#!/usr/bin/env bash
# 把内核打进每个 Skill 目录，产出可以直接拷给同事的离线 Skill。
# 安装 = 把 dist/<skill> 整个目录拷到 ~/.claude/skills/ 下。零依赖，不需要联网。
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
for s in skills/*/; do
  name=$(basename "$s")
  cp -R "$s" "dist/$name"
  cp -R kernel "dist/$name/kernel"
done
echo "打包完成（把下面每个目录整份拷到 ~/.claude/skills/ 即可）："
find dist -maxdepth 1 -mindepth 1 -type d | sort
