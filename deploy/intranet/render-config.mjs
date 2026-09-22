import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePublicOrigin } from '../../server/src/public-origin.ts';

// Render an isolated pair before installing either file. BAOX_PUBLIC_ORIGIN is the complete explicit override,
// including its external port; the Node listener remains independent in the service template.
const source = dirname(fileURLToPath(import.meta.url));
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node deploy/intranet/render-config.mjs <output-directory>');
const service = readFileSync(join(source, 'baox.service'), 'utf8');
const caddy = readFileSync(join(source, 'Caddyfile'), 'utf8');
const defaultOrigin = /^Environment=BAOX_PUBLIC_ORIGIN=(.+)$/m.exec(service)?.[1];
const site = /^([^#\s{]+) \{$/m.exec(caddy)?.[1];
if (!defaultOrigin || site !== defaultOrigin) throw new Error('Service and Caddy templates must share their default origin');
const { origin } = parsePublicOrigin(process.env.BAOX_PUBLIC_ORIGIN ?? defaultOrigin);
const url = new URL(origin);
const probePort = url.port || (url.protocol === 'https:' ? '443' : '80');
mkdirSync(destination, { recursive: true });
writeFileSync(join(destination, 'baox.service'), service.replace(/^Environment=BAOX_PUBLIC_ORIGIN=.+$/m, `Environment=BAOX_PUBLIC_ORIGIN=${origin}`));
writeFileSync(join(destination, 'Caddyfile'), caddy.replace(/^([^#\s{]+) \{$/m, `${origin} {`));
writeFileSync(join(destination, 'origin.txt'), `${origin}\n${origin}\n${url.hostname}:${probePort}:127.0.0.1:${probePort}\n`);
