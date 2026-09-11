# DESIGN.md 已迁移

视觉 token 的唯一来源现在是 [`packages/app-ui/DESIGN.md`](../packages/app-ui/DESIGN.md)。

`packages/app-ui/scripts/build-tokens.mjs` 从它的 front matter 生成 `packages/app-ui/src/styles/tokens.css`；
改样式先改那份文件，再运行 `pnpm --filter @baox/app-ui tokens`。

两份 getdesign 原件仍在本目录的 `design-md/` 下，逐字保留用于溯源。
