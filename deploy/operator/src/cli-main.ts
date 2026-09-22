import { SshCandidateTransport } from './candidate.js';
import { runOperatorCli } from './cli.js';
import { SshCutoverTransport } from './cutover.js';
import { SshHostTransport } from './host.js';
import { createSourceRepository } from './source.js';
import { SshSnapshotTransport } from './snapshot.js';

process.exitCode = await runOperatorCli(process.argv.slice(2), {
  source: createSourceRepository(process.cwd()),
  host: new SshHostTransport(),
  candidate: new SshCandidateTransport(),
  snapshot: new SshSnapshotTransport(),
  cutover: new SshCutoverTransport(),
}, {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
