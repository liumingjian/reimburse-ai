/*
  冒烟脚本：用 headless Chrome 打开 standalone-app.prototype.html 的每个阶段（通过 ?seed= 与 hash），
  dump 渲染后的 DOM，确认三点：没有未捕获异常、每页出现应有的关键字、不出现 undefined / NaN / 长破折号。
  加 --shots 时顺带截图到 /tmp/rx/shots，供目视检查。

    node docs/design/prototypes/standalone-app.smoke.mjs [--shots]
*/
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = fileURLToPath(new URL("./standalone-app.prototype.html", import.meta.url));
const chromes = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const chrome = chromes.find(existsSync);
if (!chrome) {
  console.error("FAIL 找不到 Chrome / Chromium / Edge");
  process.exit(1);
}
const shots = process.argv.includes("--shots");
const shotDir = "/tmp/rx/shots";
if (shots) mkdirSync(shotDir, { recursive: true });

const cases = [
  { name: "map", seed: "", hash: "#/", expect: ["本地报销应用 · 全流程", "直接查看", "对账（结果不确定即停）"] },
  { name: "tasks", seed: "", hash: "#/tasks", expect: ["报销任务", "对账中", "新建报销任务"] },
  { name: "new", seed: "", hash: "#/tasks/new", expect: ["新建报销任务", "创建并上传材料"] },
  { name: "upload-empty", seed: "", hash: "#/task/T1/upload", expect: ["拖入文件"] },
  { name: "upload-filled", seed: "inventory", hash: "#/task/T1/upload", expect: ["上传批次 #1", "开始材料盘点"] },
  { name: "inventory", seed: "inventory", hash: "#/task/T1/inventory", expect: ["处理 3 个待确认项", "26.69 + 20.85 + 21.65"] },
  { name: "pending", seed: "pending", hash: "#/task/T1/pending", expect: ["补填起点与终点", "保存并标记已处理", "不支持的材料类型"] },
  { name: "pending-empty", seed: "review", hash: "#/task/T1/pending", expect: ["没有待确认项了"] },
  { name: "review", seed: "review", hash: "#/task/T1/review", expect: ["确认整单明细", "3972.59", "张江高科", "补充支付截图"] },
  { name: "review-confirmed", seed: "actions", hash: "#/task/T1/review", expect: ["去打印", "去报销", "追加材料"] },
  { name: "print", seed: "print", hash: "#/task/T1/print", expect: ["No.3-5", "还没有支付截图", "下载打印稿 PDF"] },
  { name: "erp", seed: "erp", hash: "#/task/T1/erp", expect: ["开始填报", "严格回读"] },
  { name: "done", seed: "done", hash: "#/task/T1/done", expect: ["BX20260911-0173", "明细 9/9 一致"] },
  { name: "reconcile", seed: "", hash: "#/task/T2/reconcile", expect: ["金额不一致", "转人工处理", "重新对账"] },
  { name: "guard-upload", seed: "", hash: "#/task/T1/review", expect: ["还没有上传材料"] },
  { name: "guard-skip", seed: "inventory", hash: "#/task/T1/print", expect: ["阶段不可跳过"] },
];

const stripCode = (dom) => dom.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
let failed = 0;
for (const c of cases) {
  const url = `file://${html}${c.seed ? `?seed=${c.seed}` : ""}${c.hash}`;
  const args = ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--window-size=1440,1000", "--virtual-time-budget=1500", "--enable-logging=stderr", "--v=0"];
  if (shots) args.push(`--screenshot=${shotDir}/${c.name}.png`);
  else args.push("--dump-dom");
  const res = spawnSync(chrome, [...args, url], { encoding: "utf8", timeout: 40000 });
  const stderr = String(res.stderr || "");
  const problems = [];
  if (/Uncaught|ReferenceError|TypeError|SyntaxError/.test(stderr)) problems.push("控制台有未捕获异常");
  if (!shots) {
    const dom = stripCode(String(res.stdout || ""));
    for (const s of c.expect) if (!dom.includes(s)) problems.push(`缺少「${s}」`);
    for (const s of ["undefined", "NaN", "[object", "—", "–"]) if (dom.includes(s)) problems.push(`出现「${s}」`);
  }
  if (problems.length) {
    failed++;
    console.log(`FAIL ${c.name.padEnd(16)} ${problems.join("；")}`);
    const line = stderr.split("\n").find((l) => /Uncaught|Error/.test(l));
    if (line) console.log(`     ${line.slice(0, 200)}`);
  } else {
    console.log(`ok   ${c.name}`);
  }
}
console.log(failed ? `FAIL ${failed}/${cases.length}` : `PASS ${cases.length}/${cases.length}`);
process.exit(failed ? 1 : 0);
