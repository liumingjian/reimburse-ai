#!/usr/bin/env bash
# 打一个可以直接发给试用同事的压缩包：四个 Skill 目录 + 安装说明。
# 用法：bash scripts/release.sh [--allow-dirty]
set -euo pipefail
cd "$(dirname "$0")/.."

allow_dirty=false
[ "${1:-}" = "--allow-dirty" ] && allow_dirty=true

# 工作区不干净就拒绝打包。包上写着一个 commit，而那个 commit 必须真的等于包里的东西 ——
# 否则试用者报回来的问题钉在一个不存在的状态上，比没有版本号还糟。
if [ -n "$(git status --porcelain)" ] && [ "$allow_dirty" = false ]; then
  echo "工作区有未提交的改动。先提交，或者 --allow-dirty 打一个只给自己用的包。" >&2
  git status --short >&2
  exit 1
fi

bash scripts/bundle.sh

version=$(cat kernel/VERSION)
sha=$(git rev-parse --short HEAD)
name="baox-${version}-${sha}"
[ "$allow_dirty" = true ] && [ -n "$(git status --porcelain)" ] && name="${name}-dirty"

# 语法自检。打包脚本查的是"该在的文件在不在"，这里查的是"它们能不能加载"——
# 一个打不开的包发出去，同事第一条命令就撞墙。
node --check dist/baox/kernel/bin/baox.mjs

rm -rf release && mkdir -p release
(cd dist && zip -rq "../release/${name}.zip" baox baox-recover baox-setup extract-reimbursement-images INSTALL.md)

echo "打好了：release/${name}.zip"
ls -lh "release/${name}.zip" | awk '{print "  大小 " $5}'
shasum -a 256 "release/${name}.zip" 2>/dev/null || sha256sum "release/${name}.zip"
echo
echo "发给同事时带上一句：解压后把四个 Skill 目录一起安装；Codex 用 <项目>/.agents/skills/，Claude Code 用 <项目>/.claude/skills/，"
echo "其余照 INSTALL.md 走。"
