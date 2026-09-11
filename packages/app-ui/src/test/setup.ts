import { afterEach } from 'vitest';

// 大多数用例跑在 jsdom 里；少数纯文件系统用例（如 tokens.test.ts）声明了 node 环境，这里要能两边都用。
const hasDom = typeof window !== 'undefined';

if (hasDom) {
  // jsdom 没有实现 scrollTo；页面切换时会调用它。
  window.scrollTo = () => {};
}

afterEach(async () => {
  if (!hasDom) return;
  const { cleanup } = await import('@testing-library/react');
  cleanup();
  window.location.hash = '';
});
