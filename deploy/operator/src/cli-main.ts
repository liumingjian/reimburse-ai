import { SshCandidateTransport } from './candidate.js';
import { runOperatorCli } from './cli.js';
import { SshHostTransport } from './host.js';
import { createSourceRepository } from './source.js';

process.exitCode = await runOperatorCli(process.argv.slice(2), {
  source: createSourceRepository(process.cwd()),
  host: new SshHostTransport(),
  candidate: new SshCandidateTransport(),
}, {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
