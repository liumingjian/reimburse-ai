// The address colleagues reach the app at (`BAOX_PUBLIC_ORIGIN`, phase 1 `http://10.250.0.222:8888`). Unset keeps the
// 127.0.0.1-only deployment. Node binds 127.0.0.1 either way: the browser arrives through the reverse proxy in front
// of it, which passes the browser's own Host and Origin through, so the app still judges both.

export type PublicOrigin = {
  // Scheme, host and non-default port, written the way a browser writes `Origin`.
  origin: string;
  // What the same browser writes in `Host`.
  host: string;
  // Under https the session cookie carries `Secure`. Under http it must not, or the browser would drop it.
  secure: boolean;
};

// A misconfigured origin never reaches the listening socket.
export class PublicOriginRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicOriginRefusal';
  }
}

export function parsePublicOrigin(value: string): PublicOrigin {
  const written = value.trim().replace(/\/$/, '');
  let url: URL;
  try {
    url = new URL(written);
  } catch {
    throw new PublicOriginRefusal(`Public origin ${written} is not an address; write it as scheme://host[:port]`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublicOriginRefusal(`Public origin ${written} must be http or https`);
  }
  // A browser's `Origin` carries scheme, host and port and nothing else, so anything more here could never match.
  if (url.origin !== written) {
    throw new PublicOriginRefusal(`Public origin ${written} must be scheme://host[:port] and nothing more, i.e. ${url.origin}`);
  }
  const secure = url.protocol === 'https:';
  // Plaintext is only acceptable on a network the company already controls. Over http a public address would put app
  // passwords, 配对码 (pairing code) and invoice originals on the open internet in clear, so the server stops instead
  // of serving them.
  if (!secure && !isPrivateAddress(url.hostname)) {
    throw new PublicOriginRefusal(`Public origin ${written} would serve plaintext to a public address; use https, or a private address`);
  }
  return { origin: url.origin, host: url.host, secure };
}

// The public configuration wins when it exists. A loopback-only run has no configured public address, so its request
// URL is also the address used to stamp the extension package.
export function activeOrigin(publicOrigin: PublicOrigin | null, requestUrl: string): string {
  return publicOrigin?.origin ?? new URL(requestUrl).origin;
}

// A name is not an address: nothing here can tell where it resolves, so plain http is refused for one.
function isPrivateAddress(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (hostname.startsWith('[')) {
    const address = hostname.slice(1, -1).toLowerCase();
    // ::1 and the unique-local fc00::/7 block.
    return address === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(address);
  }
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first = 0, second = 0] = octets;
  return first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

// Who may talk to the app, judged from what the browser wrote. With a public origin configured, exactly that origin;
// without one, only the loopback names, since anything else is another host's name pointed at this machine (DNS
// rebinding). Two doors use these: the Hono guard in `app.ts`, and the WebSocket upgrade in `extension/websocket.ts`,
// which never reaches Hono. They share this code so neither can quietly admit what the other refuses.
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

const hostnameOf = (value: string): string | null => {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export function admitsHost(served: PublicOrigin | null, host: string): boolean {
  if (served) return host.toLowerCase() === served.host;
  const hostname = hostnameOf(host);
  return hostname !== null && LOCAL_HOSTS.has(hostname);
}

export function admitsOrigin(served: PublicOrigin | null, origin: string): boolean {
  if (served) return origin === served.origin;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}
