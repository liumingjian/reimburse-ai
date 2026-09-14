// @carbon/feature-flags 不带类型声明；这里只声明用到的 merge（App.tsx 用它打开全局开关）。
declare module '@carbon/feature-flags' {
  export function merge(flags: Record<string, boolean>): void;
}
