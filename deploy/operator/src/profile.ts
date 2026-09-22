export type NativeProfile = Readonly<{
  host: string;
  sshUser: string;
  deployRoot: string;
  dataDir: string;
  maintenanceWrapper: string;
  maintenanceSocket: string;
}>;

export const NATIVE_PROFILE: NativeProfile = {
  host: '10.250.0.222',
  sshUser: 'root',
  deployRoot: '/opt/tools/baox',
  dataDir: '/opt/tools/baox/data',
  maintenanceWrapper: '/opt/tools/baox/bin/baox-maintenance-gate',
  maintenanceSocket: '/opt/tools/baox/data/maintenance-gate.sock',
} as const;
