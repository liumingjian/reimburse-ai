/**
 * 本地页面的测试一律不许真去弹浏览器。
 *
 * 只此一份：一次性页和长驻页的测试用的是同一条开关（`BAOX_NO_AUTO_OPEN`），
 * 各抄一份的话，两边对"测试期间怎么算不弹窗"的看法迟早会分岔——而分岔的那一半
 * 不会报错，它只会在某台机器上真的弹出一堆窗口。
 *
 * 用完把环境变量恢复原样（包括原本没设过就删掉），因为同一个进程里还有别的用例。
 */
export const noAutoOpen = (fn) => async (t) => {
  const before = process.env.BAOX_NO_AUTO_OPEN;
  process.env.BAOX_NO_AUTO_OPEN = '1';
  try { await fn(t); }
  finally {
    if (before === undefined) delete process.env.BAOX_NO_AUTO_OPEN;
    else process.env.BAOX_NO_AUTO_OPEN = before;
  }
};
