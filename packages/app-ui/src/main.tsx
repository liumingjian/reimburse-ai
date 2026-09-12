import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createHttpAdapter } from './adapter/http-adapter';
import type { AppAdapter } from './contract/adapter';
import './styles/tokens.css';
import './styles/app.css';

// 适配器只在这里选择一次：mock 模式动态引入浏览器内 mock（正式构建里这段分支被常量折叠后整体剔除，
// mock 代码、测试钩子与夹具不会进入 dist/）；其余模式用 HTTP 适配器连本地应用服务（响应一律过 schema 校验）。
async function chooseAdapter(): Promise<AppAdapter> {
  if (import.meta.env.MODE === 'mock') {
    const { createMockAdapter, installMockHooks, readMockOptions } = await import('./mock/mock-adapter');
    const adapter = createMockAdapter(readMockOptions(window.location.search));
    installMockHooks(window, adapter);
    return adapter;
  }
  return createHttpAdapter();
}

const container = document.getElementById('app');
if (!container) throw new Error('页面缺少 #app 容器');

void chooseAdapter().then((adapter) => {
  createRoot(container).render(
    <StrictMode>
      <App adapter={adapter} />
    </StrictMode>,
  );
});
