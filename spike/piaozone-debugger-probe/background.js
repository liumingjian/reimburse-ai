// The service worker does nothing but open the panel. Every chrome.debugger call lives in panel.js, which runs in
// a normal extension tab: an MV3 service worker can be evicted mid-run, and a detach in the middle of a 排练
// (rehearsal) would be indistinguishable from the failure the spike is trying to measure.

const PANEL = chrome.runtime.getURL('panel.html');

chrome.action.onClicked.addListener(async () => {
  const [open] = await chrome.tabs.query({ url: PANEL });
  if (open) {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: PANEL });
});
