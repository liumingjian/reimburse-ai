#!/usr/bin/env bash
# 把内核打进每个 Skill 目录，产出可以直接拷给同事的离线 Skill。
# 安装 = 把 dist/<skill> 整个目录拷到 ~/.claude/skills/ 下。零依赖，不需要联网。
set -euo pipefail
cd "$(dirname "$0")/.."

# —— 自包含闸 ——
# Skill 目录就是分发单位：装到 ~/.claude/skills/ 之后，目录之外的路径一律不存在。
# 指向仓库里 docs/ 或 ../../ 的指针在安装后会静默失效 —— agent 不会报错，它会照着猜往下走。
# 所以这里先拦，拦不住就别打包。
violations=0
for f in skills/*/SKILL.md skills/*/references/*.md; do
  [ -e "$f" ] || continue
  if grep -nE '\]\(\.\./|\]\((\.\./)*docs/|见 `?docs/|docs/adr/|docs/research/' "$f"; then
    echo "  ^^ $f 指向 Skill 目录之外，安装后不可达" >&2
    violations=$((violations + 1))
  fi
done
if [ "$violations" -gt 0 ]; then
  echo "自包含闸没过：$violations 处指针越出 Skill 目录。要么删掉，要么把内容提炼进该 Skill 的 references/。" >&2
  exit 1
fi

rm -rf dist && mkdir -p dist
for s in skills/*/; do
  name=$(basename "$s")
  cp -R "$s" "dist/$name"
  cp -R kernel "dist/$name/kernel"
done
echo "打包完成（把下面每个目录整份拷到 ~/.claude/skills/ 即可）："
find dist -maxdepth 1 -mindepth 1 -type d | sort
