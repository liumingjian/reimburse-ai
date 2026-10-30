import { useCallback, useEffect, useState } from 'react';
import { Button, InlineNotification, RadioButton, RadioButtonGroup } from '@carbon/react';
import type { ErpBrowserMode } from '@baox/contract';
import { useAppStore } from '../adapter/context';
import { ActionGroup } from '../shell/ActionGroup';

export const ERP_BROWSER_SETTINGS_COPY = {
  title: '报销系统浏览器',
  mode: '浏览器模式',
  headless: '无头（默认）',
  headed: '有头（调试）',
  lead: '两种模式都通过已配对的本地执行器运行。无头模式不显示窗口；有头模式显示专用浏览器窗口，运行时请勿操作。',
  applies: '保存后，下次去报销、对账或试登录时生效。正在运行的任务保持原模式。',
  loading: '正在读取浏览器设置…',
  loadFailed: '浏览器设置加载失败',
  retry: '重新加载浏览器设置',
  save: '保存浏览器设置',
  saving: '正在保存…',
  saved: '浏览器设置已保存',
} as const;

export function ErpBrowserSettingsSection() {
  const store = useAppStore();
  const [savedMode, setSavedMode] = useState<ErpBrowserMode | null>(null);
  const [mode, setMode] = useState<ErpBrowserMode>('headless');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const settings = await store.adapter.getErpBrowserSettings();
      setSavedMode(settings.browserMode);
      setMode(settings.browserMode);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [store]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const outcome = await store.adapter.saveErpBrowserSettings({ browserMode: mode });
      if (!outcome.ok) {
        setError(outcome.error.message);
        return;
      }
      setSavedMode(outcome.settings.browserMode);
      setMode(outcome.settings.browserMode);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="app-form-section" aria-label={ERP_BROWSER_SETTINGS_COPY.title}>
      <h2 className="app-section-title">{ERP_BROWSER_SETTINGS_COPY.title}</h2>
      <p>{ERP_BROWSER_SETTINGS_COPY.lead}</p>
      <p>{ERP_BROWSER_SETTINGS_COPY.applies}</p>
      {loadError ? (
        <div className="app-empty">
          <p>{ERP_BROWSER_SETTINGS_COPY.loadFailed}</p>
          <p>{loadError}</p>
          <Button kind="secondary" size="md" onClick={() => void load()}>{ERP_BROWSER_SETTINGS_COPY.retry}</Button>
        </div>
      ) : savedMode === null ? (
        <p className="app-loading" role="status">{ERP_BROWSER_SETTINGS_COPY.loading}</p>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <RadioButtonGroup legendText={ERP_BROWSER_SETTINGS_COPY.mode} name="erp-browser-mode" valueSelected={mode} disabled={busy} onChange={(value) => { setMode(value as ErpBrowserMode); setSaved(false); setError(null); }}>
            <RadioButton id="erp-browser-headless" value="headless" labelText={ERP_BROWSER_SETTINGS_COPY.headless} />
            <RadioButton id="erp-browser-headed" value="headed" labelText={ERP_BROWSER_SETTINGS_COPY.headed} />
          </RadioButtonGroup>
          <ActionGroup>
            <Button type="submit" size="md" disabled={busy || mode === savedMode}>{busy ? ERP_BROWSER_SETTINGS_COPY.saving : ERP_BROWSER_SETTINGS_COPY.save}</Button>
          </ActionGroup>
          {error ? <InlineNotification kind="error" lowContrast hideCloseButton title={error} /> : null}
          {saved ? <InlineNotification kind="success" lowContrast hideCloseButton title={ERP_BROWSER_SETTINGS_COPY.saved} /> : null}
        </form>
      )}
    </section>
  );
}
