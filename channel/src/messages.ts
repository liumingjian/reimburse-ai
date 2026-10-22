// What the 本地执行器 says in more than one place, written once so the wording cannot drift between them.

/** The channel to the app went: every request still waiting on it fails with this, and a running job hears it. */
export const CHANNEL_CLOSED = { code: 'channel_closed', message: '和应用的连接断开了。' } as const;

/** `CHANNEL_CLOSED` as the error a request rejects with. */
export const channelClosed = (): Error & { code: string } => Object.assign(new Error(CHANNEL_CLOSED.message), { code: CHANNEL_CLOSED.code });

/** The app cannot be reached at all. The 本地执行器 logs what happens next: a retry on its own, or the employee's. */
export const APP_UNREACHABLE = '连不上应用。请确认你在公司网络里，应用也开着。';
