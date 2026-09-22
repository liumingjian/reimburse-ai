import Sqlite from 'better-sqlite3';
import type { Db } from './db/database';

export const MAINTENANCE_GATE_VERSION = 1;
export const MAINTENANCE_WRITE_CODE = 'maintenance_in_progress';
export const MAINTENANCE_WRITE_MESSAGE = '系统正在维护，暂时不能修改数据。';

export type MaintenanceCommand = 'status' | 'admit' | 'reopen';
export type MaintenanceState = 'open' | 'admitting' | 'admitted' | 'refused' | 'unknown';
export type MaintenanceReason = 'active_erp_attempt' | 'unknown_write_state';
export type WriteKind = 'http' | 'background' | 'erp';

export type MaintenanceStatus = {
  version: typeof MAINTENANCE_GATE_VERSION;
  state: MaintenanceState;
  barrier: boolean;
  activeWrites: number | 'unknown';
  activeErpAttempt: boolean | 'unknown';
  reason?: MaintenanceReason;
};

export type MaintenanceLease = { release: () => void };
export type MaintenanceWriteAdmission = () => MaintenanceLease | null;

export type MaintenanceGate = {
  // Resolves after the durable barrier is known. A damaged or unreadable row leaves the gate closed.
  ready: Promise<void>;
  enter: (kind: WriteKind) => MaintenanceLease | null;
  status: () => MaintenanceStatus;
  admit: () => Promise<MaintenanceStatus>;
  reopen: () => Promise<MaintenanceStatus>;
  // Records that a server-side write boundary could not be verified. Callers await this before they expose a
  // replacement process, so a later restart cannot mistake the old closed row for a verified recovery.
  failClosed: () => Promise<void>;
  onOpen: (listener: () => void) => () => void;
};

type Mode = 'loading' | 'open' | 'closing' | 'closed' | 'opening' | 'unknown';

const GATE_ID = 'main';

export type DurableMaintenanceState = 'open' | 'closed' | 'unknown';

const unknown = (): MaintenanceStatus => ({
  version: MAINTENANCE_GATE_VERSION,
  state: 'unknown',
  barrier: true,
  activeWrites: 'unknown',
  activeErpAttempt: 'unknown',
  reason: 'unknown_write_state',
});

// The emergency CLI must decide whether it may write before it opens the normal database layer: `openDatabase` can
// run migrations and create a backup. A missing table, row, or unreadable database is deliberately indistinguishable
// from a damaged barrier and therefore does not permit the write.
export function readDurableMaintenanceState(path: string): DurableMaintenanceState {
  let sqlite: Sqlite.Database | null = null;
  try {
    sqlite = new Sqlite(path, { readonly: true, fileMustExist: true });
    const row = sqlite.prepare("SELECT state FROM maintenance_gate WHERE gate_id = 'main'").get() as { state?: unknown } | undefined;
    return row?.state === 'open' || row?.state === 'closed' || row?.state === 'unknown' ? row.state : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    sqlite?.close();
  }
}

export function createMaintenanceGate(db: Db): MaintenanceGate {
  let mode: Mode = 'loading';
  let activeWrites = 0;
  let activeErpAttempts = 0;
  let transition: Promise<void> | null = null;
  const openListeners = new Set<() => void>();

  const ready = (async () => {
    try {
      const row = await db.selectFrom('maintenance_gate').select('state').where('gate_id', '=', GATE_ID).executeTakeFirst();
      // The migration creates this row. Its absence afterwards means the durable barrier cannot be trusted.
      mode = row?.state === 'open' || row?.state === 'closed' ? row.state : 'unknown';
    } catch {
      mode = 'unknown';
    }
  })();

  const status = (): MaintenanceStatus => {
    if (mode === 'loading' || mode === 'unknown') return unknown();
    if (mode === 'open') {
      return {
        version: MAINTENANCE_GATE_VERSION,
        state: 'open',
        barrier: false,
        activeWrites,
        activeErpAttempt: activeErpAttempts > 0,
      };
    }
    return {
      version: MAINTENANCE_GATE_VERSION,
      // A persistence transition has not yet established a durable boundary, even when no write is in flight.
      state: mode === 'closing' || activeWrites > 0 ? 'admitting' : 'admitted',
      barrier: true,
      activeWrites,
      activeErpAttempt: activeErpAttempts > 0,
    };
  };

  const persist = async (state: DurableMaintenanceState) => {
    const updatedAt = new Date().toISOString();
    await db
      .insertInto('maintenance_gate')
      .values({ gate_id: GATE_ID, state, updated_at: updatedAt })
      .onConflict((conflict) => conflict.column('gate_id').doUpdateSet({ state, updated_at: updatedAt }))
      .execute();
  };

  return {
    ready,
    enter(kind) {
      if (mode !== 'open') return null;
      activeWrites += 1;
      if (kind === 'erp') activeErpAttempts += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          activeWrites -= 1;
          if (kind === 'erp') activeErpAttempts -= 1;
        },
      };
    },
    status,
    async admit() {
      await ready;
      if (mode === 'unknown') return unknown();
      if (mode === 'closing') {
        await transition;
        return status();
      }
      if (mode === 'opening') {
        await transition;
        return this.admit();
      }
      if (mode === 'closed') return status();
      if (activeErpAttempts > 0) {
        return {
          version: MAINTENANCE_GATE_VERSION,
          state: 'refused',
          barrier: false,
          activeWrites,
          activeErpAttempt: true,
          reason: 'active_erp_attempt',
        };
      }

      // Closing this in memory happens before the first await. A new ERP action can therefore only start before
      // this check (and makes admission refuse), or after it (and is refused by `enter`).
      mode = 'closing';
      transition = persist('closed')
        .then(() => {
          if (mode === 'closing') mode = 'closed';
        })
        .catch(() => {
          mode = 'unknown';
        })
        .finally(() => {
          transition = null;
        });
      await transition;
      return status();
    },
    async reopen() {
      await ready;
      if (mode === 'closing') {
        await transition;
        return this.reopen();
      }
      if (mode === 'opening') {
        await transition;
        return status();
      }
      if (mode !== 'closed') return status();
      // Opening while a pre-close operation is still draining would create a mixed maintenance boundary.
      if (activeWrites > 0) return status();
      mode = 'opening';
      transition = persist('open')
        .then(() => {
          if (mode !== 'opening') return;
          mode = 'open';
          for (const listener of openListeners) listener();
        })
        .catch(() => {
          mode = 'unknown';
        })
        .finally(() => {
          transition = null;
        });
      await transition;
      return status();
    },
    async failClosed() {
      // Close synchronously first. A concurrent admission sees unknown and cannot reopen while this durable marker
      // follows an in-flight transition.
      const previous = transition;
      mode = 'unknown';
      await previous?.catch(() => undefined);
      await persist('unknown');
    },
    onOpen(listener) {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
  };
}
