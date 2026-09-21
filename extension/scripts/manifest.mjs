// The manifest is generated, never edited, because two of its fields must agree with things outside it:
//
// - `version` must be the version the server enforces its minimum against. That single source of truth is
//   `EXTENSION_VERSION` in `contract/src/extension.ts`, and `readExtensionVersion` reads it from there. Read out of
//   the source rather than imported because this script is plain node and `@baox/contract` ships as TypeScript;
//   `src/manifest.test.ts` pins that what this reads is what the contract exports, so the two cannot drift.
// - `host_permissions` must be the origin baked into the build, or the extension would be allowed to reach an
//   address its code never talks to, or not allowed to reach the one it does. The build writes
//   `EXTENSION_ORIGIN_PLACEHOLDER` (read from the contract the same way), and the server swaps in its own origin when
//   it serves the zip.

const VERSION_PATTERN = /^export const EXTENSION_VERSION = '([^']+)';$/m;
const PLACEHOLDER_PATTERN = /^export const EXTENSION_ORIGIN_PLACEHOLDER = '([^']+)';$/m;

function readConstant(contractSource, pattern, name) {
  const found = pattern.exec(contractSource);
  if (!found) throw new Error(`contract/src/extension.ts no longer declares ${name} on one line`);
  return found[1];
}

export function readExtensionVersion(contractSource) {
  return readConstant(contractSource, VERSION_PATTERN, 'EXTENSION_VERSION');
}

export function readOriginPlaceholder(contractSource) {
  return readConstant(contractSource, PLACEHOLDER_PATTERN, 'EXTENSION_ORIGIN_PLACEHOLDER');
}

export function manifestFor(version, origin) {
  return {
    manifest_version: 3,
    name: '报销助手',
    version,
    description: '在你自己的浏览器里打开报销系统，按你在应用里确认过的内容填写。',
    // ADR-0021: the detail grid needs genuinely trusted events, which only the debugger can produce. The banner it
    // shows is permanent and designed around rather than hidden.
    permissions: ['storage', 'alarms', 'debugger', 'tabs'],
    host_permissions: [`${origin}/*`],
    background: { service_worker: 'service-worker.js', type: 'module' },
    action: { default_popup: 'popup.html', default_title: '报销助手' },
  };
}
