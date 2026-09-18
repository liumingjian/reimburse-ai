import { run } from './run';

// The production entry point (`dist/main.mjs`). It wires nothing itself: everything, including which ERP executor to
// use, lives in `run.ts`. Test doubles are deliberately absent here so they cannot reach a shipped bundle; the
// Playwright `server` project builds and runs `e2e-main.ts` instead.
await run();
