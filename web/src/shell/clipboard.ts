// The deployed app is HTTPS only (ADR-0036, #413), where `navigator.clipboard` works. It is undefined where the page is
// no secure context: plain http in dev and e2e, or an address other than the configured one. A browser may also refuse
// it (no permission). The older selection copy still works in those cases; false when neither does.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (no permission, say): try the selection copy.
  }
  return copyBySelection(text);
}

function copyBySelection(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  // Selecting the temporary textarea moves focus to it; put it back on the copy button afterwards.
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    focused?.focus();
  }
}
