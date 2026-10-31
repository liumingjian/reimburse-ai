import { z } from 'zod';

export const ONBOARDING_MANIFEST_URL = '/media/onboarding/current.json';

export const OnboardingManifestSchema = z.object({
  version: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  title: z.string().trim().min(1).max(120),
  updated: z.iso.date(),
  duration: z.number().finite().positive(),
  chapters: z.array(z.object({ start: z.number().finite().nonnegative(), title: z.string().trim().min(1).max(120) })).min(1),
}).superRefine((manifest, context) => {
  for (const [index, chapter] of manifest.chapters.entries()) {
    const previous = manifest.chapters[index - 1];
    if ((index === 0 && chapter.start !== 0) || chapter.start >= manifest.duration || (previous && chapter.start <= previous.start)) {
      context.addIssue({ code: 'custom', path: ['chapters', index, 'start'], message: '章节时间必须从零开始、递增且在视频时长内。' });
    }
  }
});

export type OnboardingManifest = z.infer<typeof OnboardingManifestSchema>;

export function onboardingMedia(version: OnboardingManifest['version'], file: 'video.mp4' | 'poster.jpg' | 'subtitles.srt'): string {
  return `/media/onboarding/${version}/${file}`;
}

export function videoTime(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}
