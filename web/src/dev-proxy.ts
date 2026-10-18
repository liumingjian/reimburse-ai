import type { ProxyOptions } from 'vite';

// What `pnpm dev` passes through to the real server. Vite's own address is the one the page, and every install or
// uninstall command it prints, carries (the server takes its origin from the request), so each path the server answers
// outside the page goes here: /api with its SSE and the channel WebSocket an installed 本地执行器 opens, and the install
// and uninstall scripts the employee pipes into a shell. Literal paths, since the Vite config cannot load the contract's
// TypeScript source; `dev-proxy.test.ts` holds them to the contract.
export function devProxy(port: number | string): Record<string, ProxyOptions> {
  const target = `http://127.0.0.1:${port}`;
  return {
    '/api': { target, ws: true },
    '/install': { target },
    '/uninstall': { target },
  };
}
