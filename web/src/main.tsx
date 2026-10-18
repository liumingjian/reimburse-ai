import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createWindowBridge } from './adapter/extension-bridge';
import { createHttpAdapter } from './adapter/http-adapter';
import { createLoopbackPort, type LocalExecutorPort } from './adapter/local-executor-port';
import type { AppAdapter } from '@baox/contract';
import './styles/carbon.scss';

// 适配器只在这里选择一次：mock 模式动态引入浏览器内 mock（正式构建里这段分支被常量折叠后整体剔除，
// mock 代码、测试钩子与夹具不会进入 dist/）；其余模式用 HTTP 适配器连本地应用服务（响应一律过 schema 校验）。
// The 本地执行器 on this PC comes with it: the mock plays one (`?localExecutor=`), the real app asks 47319.
async function chooseAdapter(): Promise<{ adapter: AppAdapter; localExecutor: LocalExecutorPort }> {
  if (import.meta.env.MODE === 'mock') {
    const { createMockAdapter, installMockHooks, readMockOptions } = await import('./mock/mock-adapter');
    const adapter = createMockAdapter(readMockOptions(window.location.search));
    installMockHooks(window, adapter);
    return { adapter, localExecutor: adapter.localExecutor };
  }
  return { adapter: createHttpAdapter(), localExecutor: createLoopbackPort() };
}

const container = document.getElementById('app');
if (!container) throw new Error('页面缺少 #app 容器');

// The mock has no extension to talk to (and runs on no origin one is stamped for), so only the real app gets the bridge.
const bridge = import.meta.env.MODE === 'mock' ? undefined : createWindowBridge();

void chooseAdapter().then(({ adapter, localExecutor }) => {
  createRoot(container).render(
    <StrictMode>
      <App adapter={adapter} localExecutor={localExecutor} {...(bridge ? { bridge } : {})} />
    </StrictMode>,
  );
});
