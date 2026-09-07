#!/usr/bin/env bash
# 把内核打进每个 Skill 目录，产出可以直接拷给同事的离线 Skill。
# 安装 = 把 dist/<skill> 整个目录拷到 <项目>/.claude/skills/ 下（个人目录也行，但三个必须同处一地）。零依赖，不需要联网。
set -euo pipefail
cd "$(dirname "$0")/.."

# —— 自包含闸 ——
# Skill 目录就是分发单位：装好之后，目录之外的路径一律不存在。
# 指向仓库里 docs/ 或 ../../ 的指针在安装后会静默失效 —— agent 不会报错，它会照着猜往下走。
# 所以这里先拦，拦不住就别打包。
# 扫的是 Skill 目录下**每一个**文本文件，不只是 SKILL.md 和 references/*.md ——
# 越界指针藏在 references/ 的子目录里、或者藏在一个 .json/.sh 模板里，安装后一样是断的。
violations=0
while IFS= read -r f; do
  [ -e "$f" ] || continue
  if grep -nE '\]\(\.\./|\]\((\.\./)*docs/|见 `?docs/|docs/adr/|docs/research/' "$f"; then
    echo "  ^^ $f 指向 Skill 目录之外，安装后不可达" >&2
    violations=$((violations + 1))
  fi
done < <(find skills -type f \( -name '*.md' -o -name '*.json' -o -name '*.sh' -o -name '*.txt' \) | sort)
if [ "$violations" -gt 0 ]; then
  echo "自包含闸没过：$violations 处指针越出 Skill 目录。要么删掉，要么把内容提炼进该 Skill 的 references/。" >&2
  exit 1
fi

# —— 分发面闸 ——
# 只有走 bin/baox.mjs 的命令才有任务状态、consent 和结构化输出。kernel/ 里的 scratch-*.mjs 是
# 调试草稿：其中好几个直接上传发票、点导入、按保存，一个门禁都不过。它们留在仓库里没问题，
# 但绝不能跟着 Skill 发出去 —— 装到别人机器上就是一条绕开全部保护的写入通道。
# 所以打包只拷 VERSION / bin / src 三样，并在拷完之后复查一遍。
rm -rf dist && mkdir -p dist
for s in skills/*/; do
  name=$(basename "$s")
  cp -R "$s" "dist/$name"
  mkdir -p "dist/$name/kernel"
  cp kernel/VERSION "dist/$name/kernel/"
  cp -R kernel/bin "dist/$name/kernel/bin"
  cp -R kernel/src "dist/$name/kernel/src"
done

# 安装说明跟包走。拿到压缩包的人手上只有这个包，仓库的 README 他们看不到。
cp docs/INSTALL.md dist/INSTALL.md

# 每个包都必须带着内核入口：Skill 里的 baox 全部展开成它，缺了就是每条命令都跑不起来。
# 内核就地运行，所以包里的这一份就是真正跑的那一份，没有第二个地方可以兜底。
for s in dist/*/; do
  [ -f "$s/kernel/bin/baox.mjs" ] || { echo "内核入口闸没过：$s 里没有 kernel/bin/baox.mjs" >&2; exit 1; }
done

stowaways=$(find dist -name 'scratch-*' -o -name '*.test.mjs' | sort)
if [ -n "$stowaways" ]; then
  echo "分发面闸没过：这些文件不该出现在分发包里" >&2
  echo "$stowaways" >&2
  exit 1
fi
echo "打包完成（把下面每个目录整份拷到 <项目>/.claude/skills/ 即可，三个一起）："
find dist -maxdepth 1 -mindepth 1 -type d | sort
