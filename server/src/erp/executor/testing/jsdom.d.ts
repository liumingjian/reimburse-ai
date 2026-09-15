// The slice of jsdom the fake ERP uses. `@types/jsdom` is not used on purpose: it pulls the DOM lib into the whole
// server program and changes Node's `File`/`Blob` typing for unrelated code.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; runScripts?: 'outside-only' | 'dangerously'; pretendToBeVisual?: boolean });
    readonly window: any;
  }
}
