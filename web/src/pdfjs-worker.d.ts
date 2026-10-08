// pdfjs-dist ships no types for its minified worker; pdf-render.ts only hands the module to pdf.js.
declare module 'pdfjs-dist/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: unknown;
}
