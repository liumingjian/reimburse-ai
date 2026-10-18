import { invoiceBlobPath } from '@baox/contract';
import { ExecutorError } from '@baox/erp-executor/page';
import type { BlobSource } from '@baox/erp-executor/protocol';

// Invoice originals, fetched from the app by sha256 while a 去报销 runs here (#256). The server answers only for the
// originals named in the plan of the job running in this 应用账号's extension; the executor re-hashes every byte it
// gets (`verifiedBytes`), so a wrong answer stops the job before the ERP page is touched.

export type BlobFetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

export function serverBlobs({ origin, token, fetch }: { origin: string; token: () => Promise<string | null>; fetch: BlobFetch }): BlobSource {
  const unavailable = (fileName: string, why: string) =>
    new ExecutorError('INVOICE_BLOB_UNAVAILABLE', `没能从应用取到发票原件 ${fileName}（${why}）。报销系统没有被改动。`);
  return {
    async read(ref) {
      const bearer = await token();
      if (!bearer) throw unavailable(ref.fileName, '这个浏览器扩展没有配对');
      let response: Response;
      try {
        response = await fetch(`${origin}${invoiceBlobPath(ref.sha256)}`, { headers: { authorization: `Bearer ${bearer}` } });
      } catch (error) {
        throw unavailable(ref.fileName, String((error as Error)?.message ?? error));
      }
      if (!response.ok) throw unavailable(ref.fileName, `HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
