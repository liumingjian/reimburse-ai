import { run } from './run';

// The production entry point (`dist/main.mjs`). It wires nothing itself and passes `run` no executor, so every ERP job
// runs in the task owner's paired 浏览器扩展. The CDP executor and the test doubles are deliberately absent so they
// cannot reach a shipped bundle (`production-entry.test.ts`): `pnpm dev` runs `dev-main.ts`, and the Playwright
// `server` project builds and runs `e2e-main.ts`.
await run();
