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
  [ -x "dist/$s/kernel/bin/launch.mjs" ] && ok "$s 带着启动器且可执行" || bad "$s 缺启动器或没有执行位"
done
n=$(find dist -name 'scratch-*' -o -name '*.test.mjs' | wc -l | tr -d ' ')
[ "$n" = 0 ] && ok "分发包里没有草稿和测试文件" || bad "分发包里混进了 $n 个文件"

echo "=== 3. 启动器闸负向 ==="
mv kernel/bin/launch.mjs /tmp/launch.mjs.bak
bash scripts/bundle.sh >/dev/null 2>&1 && bad "缺启动器时 bundle 竟然退 0" || ok "缺启动器时 bundle 退非 0"
mv /tmp/launch.mjs.bak kernel/bin/launch.mjs
bash scripts/bundle.sh >/dev/null 2>&1 || bad "还原后 bundle 应该重新退 0"

echo "=== 4. 打出来的包，端到端 ==="
HOME_A=$(mktemp -d)
run() { BAOX_HOME="$HOME_A" node dist/baox/kernel/bin/launch.mjs "$@" 2>&1; }
out=$(run tasks); code=$?
[ "$code" = 2 ] && echo "$out" | grep -q runtime_not_installed \
  && ok "没装内核时 tasks 退 2 runtime_not_installed" || bad "没装内核时应退 2，实得 ${code}"

out=$(run doctor); code=$?
[ "$code" != 2 ] && ok "doctor 在未安装时放行（退 ${code}）" || bad "doctor 不该被拦"
echo "$out" | grep -q '"version"' && ok "doctor 报出版本号：$(echo "$out" | grep '"version"' | head -1 | tr -d ' ')" \
  || bad "doctor 没有版本号"

BAOX_HOME="$HOME_A" node dist/baox-setup/kernel/bin/launch.mjs install-runtime >/dev/null 2>&1 \
  && ok "install-runtime 退 0" || bad "install-runtime 退非 0"
run tasks >/dev/null 2>&1 && ok "装好之后 tasks 正常转交" || bad "装好之后 tasks 应退 0"

echo "=== 5. 版本漂移（只更新 Skill、不重装内核）==="
echo "9.9.9-drift" > dist/baox/kernel/VERSION
out=$(run tasks); code=$?
[ "$code" = 2 ] && echo "$out" | grep -q version_drift \
  && ok "漂移时 tasks 退 2 version_drift" || bad "漂移时应退 2 version_drift，实得 ${code}"
echo "$out" | grep -q '9.9.9-drift' && ok "提示里带着两边的版本号" || bad "提示里没说清版本"
BAOX_HOME="$HOME_A" node dist/baox/kernel/bin/launch.mjs install-runtime >/dev/null 2>&1 \
  && ok "漂移时 install-runtime 仍放行" || bad "漂移时 install-runtime 被误拦，用户没出路"
run tasks >/dev/null 2>&1 && ok "重装之后恢复正常" || bad "重装之后仍被拦"

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
  BAOX_HOME="$HOME_B" node "$UNZ/baox-setup/kernel/bin/launch.mjs" install-runtime >/dev/null 2>&1 \
    && ok "从解压出来的包能装起来" || bad "解压出来的包装不起来"
  BAOX_HOME="$HOME_B" node "$UNZ/baox/kernel/bin/launch.mjs" tasks >/dev/null 2>&1 \
    && ok "从解压出来的包能跑命令" || bad "解压出来的包跑不了命令"
fi

echo "=== 7. 工作区不干净时 release.sh 该拒绝 ==="
touch "$REL/dirty-probe.txt"
( cd "$REL" && bash scripts/release.sh >/dev/null 2>&1 ) \
  && bad "工作区脏时 release 竟然退 0" || ok "工作区脏时 release 拒绝打包"

echo
[ "$fail" = 0 ] && echo "ALL PASS" || echo "有失败项"
exit "$fail"
