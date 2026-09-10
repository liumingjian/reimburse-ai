import fs from 'node:fs';
import path from 'node:path';

/** Materialize files that must exist before the agent executes a returned step. */
export function materializeStepArtifacts(response) {
  if (response?.step?.kind !== 'extract_images') return [];
  const { requestPath, request } = response.step;
  if (!path.isAbsolute(requestPath) || !request || request.contractVersion !== 1) {
    const error = new Error('图片字段提取工单缺少有效的绝对 requestPath 或版本化 request');
    error.code = 'IMAGE_EXTRACTION_WORK_ORDER_INVALID';
    throw error;
  }
  fs.mkdirSync(path.dirname(requestPath), { recursive: true, mode: 0o700 });
  const temporary = `${requestPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, requestPath);
  return [requestPath];
}
