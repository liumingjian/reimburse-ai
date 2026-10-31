#!/usr/bin/env node
// Publish only the approved film, its poster and subtitles; never the production workspace or invoice originals.
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { OnboardingManifestSchema } from '../../web/src/onboarding.ts';

const { values } = parseArgs({ options: Object.fromEntries(['video', 'chapters', 'subtitles', 'version', 'updated', 'title', 'prepare-only'].map((name) => [name, { type: 'string' }])) });
const required = (name) => {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
};
function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
const video = resolve(required('video'));
const subtitles = resolve(required('subtitles'));
const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video]));
if (!probe.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264') || !probe.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')) {
  throw new Error('The tutorial must use H.264 video and AAC audio.');
}
const manifest = OnboardingManifestSchema.parse({
  version: required('version'), title: values.title ?? 'Windows 入门教程', updated: required('updated'),
  duration: Number(probe.format.duration), chapters: JSON.parse(readFileSync(required('chapters'), 'utf8')),
});
const prepared = values['prepare-only'];
const bundle = prepared ? resolve(prepared) : mkdtempSync(join(tmpdir(), 'baox-onboarding-'));
if (prepared) mkdirSync(bundle);
try {
  const versionDirectory = join(bundle, manifest.version);
  mkdirSync(versionDirectory);
  copyFileSync(video, join(versionDirectory, 'video.mp4'));
  copyFileSync(subtitles, join(versionDirectory, 'subtitles.srt'));
  run('ffmpeg', ['-v', 'error', '-i', video, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', join(versionDirectory, 'poster.jpg')]);
  const sums = ['video.mp4', 'poster.jpg', 'subtitles.srt'].map((file) => `${createHash('sha256').update(readFileSync(join(versionDirectory, file))).digest('hex')}  ${file}`).join('\n') + '\n';
  writeFileSync(join(versionDirectory, 'SHA256SUMS'), sums);
  writeFileSync(join(bundle, 'current.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (prepared) console.log(`Prepared ${bundle}`);
  else {
    const host = 'root@10.250.0.222';
    const root = '/opt/tools/baox/media/onboarding';
    const staging = `${root}/.upload-${randomUUID()}`;
    run('ssh', ['-o', 'BatchMode=yes', host, 'sh', '-s'], `set -eu\ninstall -d -o root -g root -m 0755 ${root}\nmkdir -m 0755 ${staging}\n`);
    run('scp', ['-q', '-r', '--', versionDirectory, join(bundle, 'current.json'), `${host}:${staging}/`]);
    const result = run('ssh', ['-o', 'BatchMode=yes', host, 'sh', '-s'], `set -eu
root='${root}'
stage='${staging}'
version='${manifest.version}'
cd "$stage/$version"
sha256sum -c SHA256SUMS
chmod 0755 "$stage/$version"
chmod 0644 video.mp4 poster.jpg subtitles.srt SHA256SUMS
if [ -e "$root/$version" ]; then
  cmp "$root/$version/SHA256SUMS" SHA256SUMS
else
  mv "$stage/$version" "$root/$version"
fi
chmod 0644 "$stage/current.json"
mv "$stage/current.json" "$root/current.json"
rm -rf -- "$stage"
`);
    console.log(result.trim());
    console.log(`Published ${manifest.version}: /media/onboarding/current.json`);
  }
} finally {
  if (!prepared) rmSync(bundle, { recursive: true, force: true });
}
