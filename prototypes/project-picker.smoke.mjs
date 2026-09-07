/*
  一次性冒烟脚本：把 project-picker.prototype.html 里的内联 script 抽出来，在最小 DOM 桩上跑，
  用「最优用户」走完 A/B/C 三条路，确认三点：不抛异常、37 条全部归属、核对通过。
  顺带打出实测交互次数与页面上那条估算公式的对照。跑完即删，不进主干。
*/
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./project-picker.prototype.html", import.meta.url), "utf8");
const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!source) {
  console.error("FAIL 找不到内联 script");
  process.exit(1);
}

const makeEl = () => ({
  innerHTML: "", hidden: false, value: "", type: "", checked: false, indeterminate: false, dataset: {},
  focus() {}, remove() {}, setSelectionRange() {}, scrollIntoView() {},
});
const nodes = { app: makeEl(), compare: makeEl(), "prototype-switcher": makeEl() };

globalThis.document = {
  addEventListener() {},
  getElementById: (id) => nodes[id] || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  activeElement: null,
  body: { classList: { toggle() {} }, dataset: {} },
};
globalThis.window = {
  location: { href: "http://localhost/project-picker.prototype.html?variant=A", search: "?variant=A" },
  history: { replaceState() {} },
  addEventListener() {},
  requestAnimationFrame: (fn) => fn(),
  setTimeout: () => 0,
  clearTimeout() {},
  scrollX: 0, scrollY: 0, scrollTo() {},
};

const EXPORTS = [
  "state", "counters", "ACTIONS", "estimate", "SCENARIOS", "CLUSTERS", "ALL_LINES", "PROJECTS",
  "askableClusters", "exceptionClusters", "mainProjectOfScenario", "cMainCandidates", "truthFor",
  "candidatesFor", "aCandidates", "verifyProject", "clusterById", "usedCodes", "assignedCount",
  "failuresOf", "setVariant", "toggleSelection", "bump", "projectName", "render",
];

let api;
try {
  api = new Function(`${source}\n; return { ${EXPORTS.join(", ")} };`)();
} catch (error) {
  console.error("FAIL 内联 script 无法求值：", error.message);
  process.exit(1);
}

const { state, counters, ACTIONS } = api;
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

/* 「最优用户」：一步不多走，坏码只在被拦下之后才换。 */
const runA = () => {
  api.setVariant("A");
  for (let guard = 0; guard < 30; guard += 1) {
    const pending = api.askableClusters().filter((cluster) => !state.a.answers[cluster.id]);
    if (pending.length) {
      pending.slice(0, 4).forEach((cluster) => {
        const truth = api.truthFor(cluster.id);
        if (api.aCandidates(cluster).includes(truth)) {
          ACTIONS["a-pick"]({ cluster: cluster.id, code: truth });
          return;
        }
        ACTIONS["a-other"]({ cluster: cluster.id });
        state.a.manualText = truth;
        ACTIONS["a-manual-submit"]({ cluster: cluster.id });
        if (state.a.draft[cluster.id]) return;
        const hint = api.verifyProject(truth).hint;
        check(Boolean(hint), `A：${truth} 被当场拦下但没给出可用替代`);
        state.a.manualText = hint || "";
        ACTIONS["a-manual-submit"]({ cluster: cluster.id });
      });
      ACTIONS["a-submit-round"]();
      continue;
    }
    if (!state.a.verifyResults.length) {
      ACTIONS["a-verify"]();
      continue;
    }
    if (!api.failuresOf(state.a.verifyResults).length) return;
  }
  failures.push("A：30 步内没走完");
};

const runB = () => {
  api.setVariant("B");
  ACTIONS["b-open"]();
  api.askableClusters().forEach((cluster) => {
    const truth = api.truthFor(cluster.id);
    if (!api.candidatesFor(cluster, state.b.assign).includes(truth)) api.bump("B 搜索项目清单");
    api.toggleSelection(state.b, cluster.lines.map((line) => line.id), `整簇「${cluster.title}」`);
    ACTIONS["b-assign"]({ code: truth });
    check(!state.b.pendingOverwrite, `B：${cluster.id} 不该弹覆盖确认`);
  });
  ACTIONS["b-verify"]();
  api.failuresOf(state.b.verifyResults).forEach((failure) => {
    ACTIONS["b-select-failed"]({ code: failure.code });
    ACTIONS["b-assign"]({ code: failure.hint });
    check(!state.b.pendingOverwrite, "B：就地改派坏码不该弹覆盖确认");
  });
};

const runC = () => {
  api.setVariant("C");
  const main = api.mainProjectOfScenario();
  if (api.cMainCandidates().includes(main)) {
    ACTIONS["c-pick-main"]({ code: main });
  } else {
    ACTIONS["c-other-main"]();
    state.c.manualText = main;
    ACTIONS["c-manual-submit"]({});
  }
  check(state.c.draftMain === main, "C：主项目没选上");
  const exceptions = api.exceptionClusters();
  ACTIONS["c-exception"]({ value: exceptions.length ? "yes" : "no" });
  ACTIONS["c-submit-opener"]();
  if (!exceptions.length) {
    ACTIONS["c-verify-terminal"]();
    return;
  }
  ACTIONS["c-open"]();
  exceptions.forEach((cluster) => {
    api.toggleSelection(state.c, cluster.lines.map((line) => line.id), `整簇「${cluster.title}」`);
    ACTIONS["c-assign"]({ code: api.truthFor(cluster.id) });
    check(!state.c.pendingOverwrite, `C：${cluster.id} 改派不该弹覆盖确认`);
  });
  ACTIONS["c-verify"]();
  api.failuresOf(state.c.verifyResults).forEach((failure) => {
    ACTIONS["c-select-failed"]({ code: failure.code });
    ACTIONS["c-assign"]({ code: failure.hint });
  });
};

const RUNNERS = { A: runA, B: runB, C: runC };

const rows = [];
api.SCENARIOS.forEach((item) => {
  ACTIONS["set-scenario"]({ scenario: item.key });
  ["A", "B", "C"].forEach((key) => {
    try {
      RUNNERS[key]();
    } catch (error) {
      failures.push(`${item.key}/${key} 抛异常：${error.message}`);
      return;
    }
    const vs = key === "A" ? state.a : key === "B" ? state.b : state.c;
    const results = vs.verifyResults;
    check(api.assignedCount(vs.assign) === api.ALL_LINES.length, `${item.key}/${key}：只归属了 ${api.assignedCount(vs.assign)}/${api.ALL_LINES.length} 条`);
    check(results.length > 0, `${item.key}/${key}：没跑核对`);
    check(api.failuresOf(results).length === 0, `${item.key}/${key}：核对仍未通过`);
    rows.push({
      scenario: item.name,
      variant: key,
      measured: counters[key].actions,
      estimated: api.estimate(key).actions,
      browser: counters[key].browser,
      codes: api.usedCodes(vs.assign).length,
    });
  });
});

/* 顺风局走不到的分支也得能渲染：手打被拦、核对失败、逃生口、覆盖确认。 */
const renderBranch = (label, prepare) => {
  try {
    prepare();
    api.render({ preserve: false });
  } catch (error) {
    failures.push(`渲染分支「${label}」抛异常：${error.message}`);
  }
};

ACTIONS["reset-all"]({});

/* 用第一轮里的簇，好让报错渲染在问题卡片内部。 */
renderBranch("A · 手打被当场拦下", () => {
  api.setVariant("A");
  ACTIONS["a-other"]({ cluster: "gz" });
  state.a.manualText = "P-2211";
  ACTIONS["a-manual-submit"]({ cluster: "gz" });
  check(state.a.manualError?.verdict === "unusable", "A：P-2211 应当场判为 unusable 并硬阻塞");
  check(!state.a.draft.gz, "A：被拦下的编码不该写进本题答案");
});

renderBranch("A · ambiguous 指认清单错位", () => {
  state.a.manualText = "P-3050";
  ACTIONS["a-manual-submit"]({ cluster: "gz" });
  check(state.a.manualError?.verdict === "ambiguous", "A：P-3050 应判为 ambiguous");
});

renderBranch("A · missing（清单有、ERP 没有）", () => {
  state.a.manualText = "P-2301";
  ACTIONS["a-manual-submit"]({ cluster: "gz" });
  check(state.a.manualError?.verdict === "missing", "A：P-2301 应判为 missing");
});

renderBranch("B · 逃生口 + 覆盖确认 + 核对失败", () => {
  api.setVariant("B");
  ACTIONS["b-open"]();
  const gz = api.clusterById("gz");
  api.toggleSelection(state.b, gz.lines.map((line) => line.id), "整簇");
  ACTIONS["b-assign"]({ code: "P-1120" });
  api.toggleSelection(state.b, gz.lines.map((line) => line.id), "整簇");
  ACTIONS["b-assign"]({ code: "P-1121" });
  check(Boolean(state.b.pendingOverwrite), "B：改派用户自己选过的簇应当弹覆盖双出口");
  ACTIONS["b-overwrite"]({ mode: "cancel" });
  ACTIONS["b-panel-manual-open"]();
  state.b.manualText = "P-2211";
  api.toggleSelection(state.b, gz.lines.map((line) => line.id), "整簇");
  ACTIONS["b-panel-manual-submit"]();
  check(state.b.manualError?.verdict === "unusable", "B：逃生口手打坏码应就地报核对失败");
  ACTIONS["b-toggle-cluster"]({ cluster: "gz" });
});

renderBranch("C · 起手式核对失败", () => {
  api.setVariant("C");
  ACTIONS["c-other-main"]();
  state.c.manualText = "P-1042";
  ACTIONS["c-manual-submit"]({});
  ACTIONS["c-exception"]({ value: "no" });
  ACTIONS["c-submit-opener"]();
  ACTIONS["c-verify-terminal"]();
  ACTIONS["c-reopen"]();
});

renderBranch("C · 例外页 + 只看主项目筛选", () => {
  ACTIONS["c-pick-main"]({ code: "P-1042" });
  ACTIONS["c-exception"]({ value: "yes" });
  ACTIONS["c-submit-opener"]();
  ACTIONS["c-open"]();
  ACTIONS["c-toggle-filter"]();
  ACTIONS["c-toggle-cluster"]({ cluster: "inv" });
  ACTIONS["c-panel-manual-open"]();
});

/* 上面的分支跑脏了计数，重置后再输出正式表格。 */
["A", "B", "C"].forEach((key) => {
  api.setVariant(key);
  ACTIONS["reset-variant"]({});
});

console.log("场景        变体  实测  估算  开浏览器  用到项目数");
rows.forEach((row) => {
  const flag = row.measured === row.estimated ? "" : "   <= 实测与估算不一致";
  console.log(
    `${row.scenario.padEnd(10, "　")}  ${row.variant}    ${String(row.measured).padStart(3)}  ${String(row.estimated).padStart(4)}  ${String(row.browser).padStart(6)}  ${String(row.codes).padStart(8)}${flag}`,
  );
});

const mismatches = rows.filter((row) => row.measured !== row.estimated);
mismatches.forEach((row) => failures.push(`${row.scenario}/${row.variant}：实测 ${row.measured} ≠ 估算 ${row.estimated}`));

console.log("");
if (failures.length) {
  console.log(`FAIL ${failures.length} 项：`);
  failures.forEach((message) => console.log(`  - ${message}`));
  process.exit(1);
}
console.log(`PASS 3 场景 × 3 变体全部走通，${api.ALL_LINES.length} 条明细全部归属且核对通过。`);
