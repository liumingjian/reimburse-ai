import { afterEach } from 'vitest';

// 大多数用例跑在 jsdom 里；少数纯文件系统用例（如 no-dash.test.ts）声明了 node 环境，这里要能两边都用。
const hasDom = typeof window !== 'undefined';

if (hasDom) {
  // jsdom 没有实现 scrollTo；页面切换时会调用它。
  window.scrollTo = () => {};
  // jsdom 没有 matchMedia 与 ResizeObserver；Carbon 的顶栏、弹层与浮层会用到。
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
  if (typeof window.ResizeObserver !== 'function') {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  // findBy*/waitFor 默认只等 1 秒。Mac 被桌面应用占满时，页面走完 mock 的几个阶段会超过 1 秒，整批用例变红而代码没错。
  // 条件一满足就返回，所以放宽不拖慢通过的用例。用例级上限见 vite.config.ts 的 testTimeout。
  const { configure } = await import('@testing-library/react');
  configure({ asyncUtilTimeout: 5000 });
}

afterEach(async () => {
  if (!hasDom) return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
  window.location.hash = '';
  // mock 把身份登记与常驻城市写进 localStorage（刷新后仍在）；用例之间不共享。
  // Node 25+ 自带的 localStorage 全局会遮住 jsdom 的，window.localStorage 可能是 undefined（mock 此时退回内存存储）。
  window.localStorage?.clear?.();
});
