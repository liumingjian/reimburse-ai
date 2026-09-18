# Invoice originals stay central, protected by full-disk encryption rather than an envelope

Once the server runs on Linux and serves several people, the invoice originals (PDFs and images) need a home and a protection model. Decided in [#226](https://github.com/liumingjian/reimburse-ai/issues/226); it builds on ADR-0018's ownership model.

## Decisions

- **Originals are stored centrally**, reachable only through their owner's tasks.
- **Protection is full-disk (or partition) encryption plus encrypted backups**, combined with owner-scoped authorisation on every read path.
- **No application-level envelope encryption.** No per-file data keys, no master key held by the service.
- A retention and cleanup policy after a reimbursement completes is a sensible later addition on top of this, not a substitute for it.

## Considered Options

- **Keep no originals: store only OCR results and hashes, and have the extension read files from the user's disk at fill time.** Rejected. It sounds best for privacy but removes half the product: 去打印 (go to print) composes the originals into a printable document, and 收票单号 (receipt number) readback checks against them. It also loses everything when a user changes machines.
- **Per-file data keys under a master key (envelope encryption).** Rejected. The server *must* read plaintext to run OCR, compose print output and verify readback, so the master key would live in the service process and the decrypt path would run constantly. It does not defend against "the application is compromised"; it defends against "someone walks off with the disk", which full-disk encryption already covers. In this threat model it is paper benefit and real complexity.

## Consequences

- Every read path for originals carries an owner check.
- Deployment documentation must specify an encrypted volume and encrypted backups; the protection is operational, so a misconfigured deployment silently loses it.
- Content-addressed blob deduplication stays as ADR-0018 requires: blobs may be shared on disk but are reachable only through the owner's tasks.
