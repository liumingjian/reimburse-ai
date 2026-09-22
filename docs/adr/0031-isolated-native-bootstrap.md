# Isolated native bootstrap

The fixed intranet host needs a modern C++ toolchain and Python for native Node builds, but its system compiler and
runtime are shared infrastructure. The deployment path must therefore acquire only the build inputs it needs and keep
the built runtime outside the system package and loader namespaces.

## Decision

- A separate operator command previews the exact dnf transaction and requires the reviewed transaction digest for an
  apply. It rejects a transaction that changes `gcc`, `glibc`, `libstdc++`, or `libgcc`, including dependency actions.
- GCC 12.5.0 is built under `/opt/tools/baox/runtime/gcc-12.5.0`; it does not update the system compiler, loader, or
  library configuration.
- The `baox` account has `/home/baox` as its home. Its uv executable, managed CPython, and build virtual environment
  live below that home and are checked through a clean `runuser -u baox env -i` execution.
- Proxy values are written only to root-owned mode-0600 `/opt/tools/baox/etc/build.env`. Routine deployment reads
  readiness and refuses missing prerequisites; it does not repair them.
- Direct proxy and relay acquisition use the same fixed asset digests on the host. GCC also receives a host-side
  detached-signature check against a pinned GNU signer fingerprint. UV provenance is authenticated on the operator
  through a pinned GitHub Artifact Attestation policy before apply; CPython is pinned by the authenticated UV catalog
  and installed from a verified offline cache.

## Consequences

The first bootstrap is an explicit maintenance action rather than a side effect of a deployment. It may refuse an
existing `baox` account whose home does not match the isolated layout; correcting that mismatch is an operator repair,
not an automated account migration. A proxy outage, a changed release attestation, a changed artifact digest, or a
changed package transaction stops before the application release lifecycle begins.

This keeps the old direct installer out of the routine upgrade path. It may remain for a deliberately controlled
repair until the candidate lifecycle replaces it, but it cannot be used to bypass maintenance admission or to install
native prerequisites during a routine deployment.
