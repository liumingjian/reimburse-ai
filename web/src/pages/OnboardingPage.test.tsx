import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';
import { OnboardingManifestSchema } from '../onboarding';

const manifest = { version: '2026-10-31-xiaoxiao', title: 'Windows 入门教程', updated: '2026-10-31', duration: 360.102, chapters: [{ start: 0, title: '首次准备' }, { start: 136.182, title: '新建与上传' }] };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('public onboarding video', () => {
  test('signed-out visitors can view the film, seek to a chapter, change speed and download without signing in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(manifest))));
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    window.location.hash = '#/onboarding';
    render(<App adapter={createMockAdapter({ seed: null, fault: null, auth: 'signed-out' })} />);
    await screen.findByRole('heading', { name: 'Windows 入门教程' });
    expect(screen.queryByRole('textbox', { name: '用户名' })).toBeNull();
    const player = screen.getByLabelText<HTMLVideoElement>('Windows 入门视频');
    expect(player.autoplay).toBe(false);
    Object.defineProperty(player, 'readyState', { value: 1 });
    fireEvent.click(screen.getByRole('button', { name: /新建与上传/ }));
    expect(player.currentTime).toBe(136.182);
    fireEvent.change(screen.getByLabelText('播放速度'), { target: { value: '1.5' } });
    expect(player.playbackRate).toBe(1.5);
    expect(screen.getByRole('link', { name: '下载视频' }).getAttribute('download')).toBeTruthy();
    expect(screen.getByRole('link', { name: '下载视频' }).getAttribute('href')).toBe('/media/onboarding/2026-10-31-xiaoxiao/video.mp4');
  });

  test('an unavailable manifest offers a retry, without opening the account gate', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(new Response(JSON.stringify(manifest)));
    vi.stubGlobal('fetch', fetcher);
    window.location.hash = '#/onboarding';
    render(<App adapter={createMockAdapter({ seed: null, fault: null, auth: 'signed-out' })} />);
    await screen.findByText('暂时无法加载视频，请检查网络后重试。');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByRole('heading', { name: 'Windows 入门教程' });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  test('publishing metadata cannot escape the media directory or contain unordered/out-of-range chapters', () => {
    expect(OnboardingManifestSchema.safeParse(manifest).success).toBe(true);
    for (const version of ['../invoice', '/api/tasks', 'https://example.com/video']) expect(OnboardingManifestSchema.safeParse({ ...manifest, version }).success).toBe(false);
    for (const starts of [[1], [0, 0], [0, 400]]) expect(OnboardingManifestSchema.safeParse({ ...manifest, chapters: starts.map((start) => ({ start, title: '章节' })) }).success).toBe(false);
  });
});
