# Publish the onboarding video

The public intranet tutorial is `http://10.250.0.222:8888/#/onboarding`. Login and registration offer a link; the signed-in header opens the same page in a new tab. Business endpoints still require an application account.

The film, poster and subtitles live under `/opt/tools/baox/media/onboarding/<version>/`, outside both application releases and invoice storage. Caddy serves this directory with byte-range support. `current.json` is revalidated; versioned files are immutable and may be cached. Keep old version directories when publishing a replacement so a viewer already watching can finish.

## Publish or replace a film

Run on the maintainer's Mac with Node 24, the workspace dependencies, FFmpeg/ffprobe, and the existing SSH access to the intranet host:

```sh
node deploy/intranet/publish-onboarding.mjs \
  --video /absolute/path/approved-film.mp4 \
  --chapters /absolute/path/chapters.json \
  --subtitles /absolute/path/subtitles.srt \
  --version 2026-10-31-xiaoxiao \
  --updated 2026-10-31
```

The chapter input is an array with `start` (seconds) and `title`. Extra production fields, including narration, are omitted from the published manifest. The first chapter starts at zero; subsequent starts increase and remain within the measured film duration. The video must contain H.264 and AAC. The tool extracts a poster from the approved video and uploads only these three assets and the sanitized manifest.

Use a new version when bytes change. The publisher checks SHA-256 on the host, installs the complete version directory, and atomically switches `current.json` last. Republishing the same version succeeds only with identical checksums. No application release is needed to replace an existing tutorial. The publication process leaves business data and ERP untouched.

To review a bundle locally without uploading, add `--prepare-only /absolute/path/to/a-new-directory`. The destination must not exist. The source files remain unchanged.

For the first rollout, publish the media before deploying the application entry. Deploy the application through the normal operator and full test gate. Later application upgrades replace `current`, not `media`, so the film survives. When changing the public origin, retain the Caddy media handler under that origin.

## Verify

- Open the login link without a session; open the header link while a task is in progress and check the original tab stays on that task.
- In Windows Edge, play the real film, seek to a later chapter, change speed, enter full screen, and download it.
- Verify MP4 MIME and length, a full request returning 200, a byte-range request returning 206, and an out-of-range request returning 416.
- Verify `current.json` has `Cache-Control: no-cache`, while versioned assets have an immutable cache policy.
- Verify anonymous access to a business endpoint is still refused and directory browsing is unavailable.
- Confirm media checksums remain the same across an application deployment.

Do not publish the editable production ZIP, original invoices, raw recordings, credentials, or the private production directory.
