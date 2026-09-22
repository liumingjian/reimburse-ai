export type NativeProfile = Readonly<{
  host: string;
  sshUser: string;
  deployRoot: string;
  dataDir: string;
  serviceHome: string;
  systemdDir: string;
  buildEnvironment: string;
  buildPython: string;
  maintenanceWrapper: string;
  maintenanceSocket: string;
}>;

export const NATIVE_PROFILE: NativeProfile = {
  host: '10.250.0.222',
  sshUser: 'root',
  deployRoot: '/opt/tools/baox',
  dataDir: '/opt/tools/baox/data',
  serviceHome: '/home/baox',
  systemdDir: '/etc/systemd/system',
  buildEnvironment: '/opt/tools/baox/etc/build.env',
  buildPython: '/home/baox/.local/share/baox-build-venv/bin/python',
  maintenanceWrapper: '/opt/tools/baox/bin/baox-maintenance-gate',
  maintenanceSocket: '/opt/tools/baox/data/maintenance-gate.sock',
} as const;
