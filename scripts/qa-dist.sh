#!/usr/bin/env bash
# 分发链路的验收。跑在 mac 上。
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
ok()  { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; fail=1; }

echo "=== 1. 内核测试 ==="
node --test kernel/test/*.test.mjs > /tmp/baox-tests.log 2>&1
tcode=$?
grep -E '^(ℹ (tests|pass|fail)|not ok)' /tmp/baox-tests.log || true
[ "${tcode}" = 0 ] && ok "内核测试全过" || { bad "内核测试有失败"; grep -A12 '^not ok' /tmp/baox-tests.log | head -40; }

echo "=== 2. bundle.sh 正向 ==="
bash scripts/bundle.sh >/dev/null 2>&1 && ok "bundle 退 0" || bad "bundle 退非 0"
[ -f dist/INSTALL.md ] && ok "INSTALL.md 跟包走" || bad "包里没有 INSTALL.md"
for s in baox baox-recover baox-setup; do
  [ -x "dist/$s/kernel/bin/baox.mjs" ] && ok "$s 带着内核入口且可执行" || bad "$s 缺内核入口或没有执行位"
done
codex_metadata=1
for s in baox baox-recover baox-setup extract-reimbursement-images; do
  [ -f "dist/$s/agents/openai.yaml" ] || codex_metadata=0
done
[ "$codex_metadata" = 1 ] && ok "四份 Skill 都带 Codex agents/openai.yaml" || bad "分发包缺少 Codex Skill 元数据"
[ -f dist/extract-reimbursement-images/runtime/dist/cli.js ] \
  && [ -f dist/extract-reimbursement-images/runtime/python/requirements-rapid.txt ] \
  && grep -q '"type": "module"' dist/extract-reimbursement-images/runtime/package.json \
  && ok "图片字段提取 Skill 带着 CLI 与锁定依赖" || bad "图片字段提取 Skill 不完整"
n=$(find dist -name 'scratch-*' -o -name '*.test.mjs' | wc -l | tr -d ' ')
[ "$n" = 0 ] && ok "分发包里没有草稿和测试文件" || bad "分发包里混进了 $n 个文件"

echo "=== 3. 内核入口闸负向 ==="
mv kernel/bin/baox.mjs /tmp/baox.mjs.bak
bash scripts/bundle.sh >/dev/null 2>&1 && bad "缺内核入口时 bundle 竟然退 0" || ok "缺内核入口时 bundle 退非 0"
mv /tmp/baox.mjs.bak kernel/bin/baox.mjs
bash scripts/bundle.sh >/dev/null 2>&1 || bad "还原后 bundle 应该重新退 0"

echo "=== 4. 打出来的包，基础命令可启动 ==="
HOME_A=$(mktemp -d)
run() { env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_SKILL_DIR -u AI_AGENT \
  BAOX_HOME="$HOME_A" node dist/baox/kernel/bin/baox.mjs "$@" 2>&1; }
out=$(run tasks); code=$?
[ "$code" = 0 ] && ok "拿到包就能直接跑 tasks" || bad "第一条命令就该能跑，实得 ${code}：$out"

HOME_RESET=$(mktemp -d)
out=$(BAOX_HOME="$HOME_RESET" node dist/baox/kernel/bin/baox.mjs reset 2>&1); code=$?
[ "$code" = 0 ] && echo "$out" | grep -q '"status": "reset"' \
  && [ -z "$(find "$HOME_RESET" -mindepth 1 -print -quit)" ] \
  && ok "分发包的 reset 对空环境幂等且不创建状态" \
  || bad "分发包的 reset 空环境契约失败：${out}"

out=$(run doctor)
echo "$out" | grep -q '"version"' && ok "doctor 报出版本号：$(echo "$out" | grep '"version"' | head -1 | tr -d ' ')" \
  || bad "doctor 没有版本号"
echo "$out" | grep -q "\"$HOME_A\"" && ok "BAOX_HOME 指到哪，数据目录就落在哪" || bad "doctor 的 dataDir 没跟着 BAOX_HOME 走"

echo "=== 5. 0.9.x 数据目录迁到 ~/.baox ==="
# 用一个假 HOME 跑：os.homedir() 在 posix 上认 $HOME，所以这里验的是真实的默认路径行为。
HOME_C=$(mktemp -d)
case "$(uname -s)" in
  Darwin) LEGACY="$HOME_C/Library/Application Support/baox" ;;
  *)      LEGACY="$HOME_C/.local/share/baox" ;;
esac
mkdir -p "$LEGACY/tasks" "$LEGACY/chrome-profile" "$LEGACY/runtime/bin"
echo '{"tasks":[]}' > "$LEGACY/tasks/index.json"
out=$(env -u BAOX_HOME -u XDG_DATA_HOME -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
  -u CLAUDE_SKILL_DIR -u AI_AGENT HOME="$HOME_C" node dist/baox/kernel/bin/baox.mjs tasks 2>&1); code=$?
[ "$code" = 0 ] && ok "带着旧数据目录时第一条命令照样退 0" || bad "迁移时 tasks 退了 ${code}：$out"
echo "$out" | grep -q '"migrated"' && ok "输出里说清了迁到哪：$(echo "$out" | grep -A2 '"migrated"' | tr -d ' \n')" \
  || bad "迁移了却没在输出里说一句"
[ -f "$HOME_C/.baox/tasks/index.json" ] && ok "旧任务落到了 ~/.baox" || bad "~/.baox 里没有迁过来的任务"
[ -f "$LEGACY/tasks/index.json" ] && ok "旧目录原样留着，能回滚 0.9.x" || bad "旧目录被动了 —— 必须是拷贝不是移动"
[ ! -d "$HOME_C/.baox/runtime" ] && ok "旧的 runtime/ 没跟着搬" || bad "把已经不存在的概念搬过来了"
out=$(env -u BAOX_HOME -u XDG_DATA_HOME -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
  -u CLAUDE_SKILL_DIR -u AI_AGENT HOME="$HOME_C" node dist/baox/kernel/bin/baox.mjs tasks 2>&1)
echo "$out" | grep -q '"migrated"' && bad "迁移不该发生第二次" || ok "迁移只发生一次"

echo "=== 6. release.sh ==="
# mac 上的 .git 只是指回服务器的一个指针文件，release.sh 的版本追溯在这里无从谈起。
# 所以把工作区整份拷进一个真正的仓库里跑 —— 这一步要验的是打包和自检，不是版本控制本身。
REL=$(mktemp -d)/repo
mkdir -p "$REL" && cp -R ./ "$REL"/ 2>/dev/null
rm -rf "$REL/dist" "$REL/release" "$REL/.git"
( cd "$REL" && git init -q && git add -A \
    && git -c user.email=qa@example.com -c user.name=qa commit -qm baseline )
( cd "$REL" && bash scripts/release.sh 2>&1 | tail -6 )
zipf=$(ls "$REL"/release/*.zip 2>/dev/null | head -1)
[ -n "$zipf" ] && ok "产出 $(basename "$zipf")" || bad "没有产出压缩包"
if [ -n "$zipf" ]; then
  UNZ=$(mktemp -d); unzip -q "$zipf" -d "$UNZ"
  echo "  包内顶层： $(ls "$UNZ" | tr '\n' ' ')"
  HOME_B=$(mktemp -d)
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_SKILL_DIR -u AI_AGENT \
    BAOX_HOME="$HOME_B" node "$UNZ/baox/kernel/bin/baox.mjs" tasks >/dev/null 2>&1 \
    && ok "解压出来的包直接就能跑命令" || bad "解压出来的包跑不了命令"
fi

echo "=== 7. 工作区不干净时 release.sh 该拒绝 ==="
touch "$REL/dirty-probe.txt"
( cd "$REL" && bash scripts/release.sh >/dev/null 2>&1 ) \
  && bad "工作区脏时 release 竟然退 0" || ok "工作区脏时 release 拒绝打包"

echo
[ "$fail" = 0 ] && echo "ALL PASS" || echo "有失败项"
exit "$fail"
