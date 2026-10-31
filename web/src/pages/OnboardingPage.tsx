import { useEffect, useRef, useState } from 'react';
import { Button } from '@carbon/react';
import { ONBOARDING_MANIFEST_URL, OnboardingManifestSchema, onboardingMedia, videoTime, type OnboardingManifest } from '../onboarding';
import { TASKS_HASH } from '../router';
import { AppShell } from '../shell/AppShell';
import { PageHeader } from '../shell/PageHeader';

type VideoState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; manifest: OnboardingManifest };

function Tutorial({ manifest }: { manifest: OnboardingManifest }) {
  const video = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const [position, setPosition] = useState(0);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);
  const current = manifest.chapters.reduce((selected, chapter, index) => chapter.start <= position ? index : selected, 0);
  const jumpTo = (start: number) => {
    const player = video.current;
    if (!player) return;
    if (player.readyState >= 1) player.currentTime = start;
    else pendingSeek.current = start;
    setPosition(start);
    player.focus();
    void player.play().catch(() => { /* Native controls remain available if the browser requires another play gesture. */ });
  };
  return (
    <>
      <PageHeader title={manifest.title} lead={`Windows · ${videoTime(manifest.duration)} · ${manifest.chapters.length} 个章节 · 更新于 ${manifest.updated}`} />
      <p className="app-lead">从首次准备到日常报销，视频已含中文字幕。演示止于草稿暂存，检查无误后由你本人提交。</p>
      <div className="app-tutorial-layout">
        <section aria-label="入门视频播放">
          <video
            className="app-tutorial-player" ref={video} controls playsInline preload="metadata" aria-label="Windows 入门视频"
            src={onboardingMedia(manifest.version, 'video.mp4')} poster={onboardingMedia(manifest.version, 'poster.jpg')}
            onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
            onLoadedMetadata={(event) => {
              if (pendingSeek.current !== null) { event.currentTarget.currentTime = pendingSeek.current; pendingSeek.current = null; }
              event.currentTarget.playbackRate = rate;
            }}
            onError={() => setFailed(true)}
          />
          {failed ? <p role="alert">视频暂时无法播放，请检查网络后刷新页面重试。</p> : null}
          <div className="app-tutorial-tools">
            <label>播放速度 <select aria-label="播放速度" value={rate} onChange={(event) => {
              const next = Number(event.target.value); setRate(next); if (video.current) video.current.playbackRate = next;
            }}>{[0.75, 1, 1.25, 1.5, 2].map((speed) => <option key={speed} value={speed}>{speed} 倍</option>)}</select></label>
            <a href={onboardingMedia(manifest.version, 'video.mp4')} download="baox-Windows入门教程.mp4">下载视频</a>
            <a href={onboardingMedia(manifest.version, 'subtitles.srt')} download="baox-Windows入门教程.srt">下载字幕</a>
          </div>
        </section>
        <nav className="app-tutorial-chapters" aria-label="视频章节">
          <h2>章节</h2>
          <ol>{manifest.chapters.map((chapter, index) => <li key={chapter.start}>
            <button type="button" aria-current={index === current ? 'true' : undefined} onClick={() => jumpTo(chapter.start)}>
              <time>{videoTime(chapter.start)}</time><span>{chapter.title}</span>
            </button>
          </li>)}</ol>
        </nav>
      </div>
    </>
  );
}

export function OnboardingPage() {
  const [state, setState] = useState<VideoState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const response = await fetch(ONBOARDING_MANIFEST_URL, { cache: 'no-cache', signal: controller.signal });
        if (!response.ok) throw new Error('Video manifest unavailable');
        const manifest = OnboardingManifestSchema.parse(await response.json());
        if (!controller.signal.aborted) setState({ kind: 'ready', manifest });
      } catch {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      }
    })();
    return () => controller.abort();
  }, [attempt]);
  return <AppShell nav="onboarding">
    <div className="app-tutorial">
      <p className="app-caption"><a href={TASKS_HASH}>返回报销平台</a></p>
      {state.kind === 'loading' ? <p role="status">正在加载入门视频…</p> : state.kind === 'error' ? <>
        <PageHeader title="入门视频" lead="暂时无法加载视频，请检查网络后重试。" />
        <Button kind="secondary" onClick={() => setAttempt((value) => value + 1)}>重试</Button>
      </> : <Tutorial key={state.manifest.version} manifest={state.manifest} />}
    </div>
  </AppShell>;
}
