/** Keep the invoice assistant's file chooser batches homogeneous. */
export function invoiceUploadGroups(paths = []) {
  const groups = new Map();
  for (const file of paths) {
    const match = /\.([^.]+)$/.exec(String(file));
    const format = (match?.[1] ?? '').toLowerCase().replace('jpeg', 'jpg');
    if (!['pdf', 'png', 'jpg'].includes(format)) {
      const error = new Error(`发票文件格式不受支持：${file}`);
      error.code = 'INVOICE_FORMAT_UNSUPPORTED';
      throw error;
    }
    const group = groups.get(format) ?? [];
    group.push(file);
    groups.set(format, group);
  }
  return [...groups.values()];
}
