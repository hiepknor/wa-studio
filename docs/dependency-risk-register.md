# Dependency risk register

This register records accepted transitive dependency warnings for the Apple Silicon desktop release.
It is not an ignore list: every release still runs npm audit, signature audit, dependency review,
CodeQL, and cargo-audit. A new vulnerability or a changed dependency path requires a fresh review.

## 2026-09-04 desktop candidate

- `cargo audit` reports no vulnerability and exits successfully. The previously yanked
  `chacha20 0.10.1` lock entry was advanced to `0.10.2` without changing the direct dependency set.
- `glib 0.18.5` (`RUSTSEC-2024-0429`) and the unmaintained GTK3 family remain in the cross-platform
  lockfile through Tauri's Linux implementation. `cargo tree --target aarch64-apple-darwin -i glib`
  resolves no path, so these crates are not compiled into the supported `darwin-aarch64` product.
  They block any future Linux product claim until the dependency family is replaced or separately
  reviewed.
- The remaining `unic-*` and related unmaintained warnings are transitive Tauri/urlpattern build
  dependencies, not known vulnerabilities. They are accepted only for this candidate while pinned
  CI, CodeQL, SBOM, provenance, and Dependabot monitoring remain active. A Tauri update that removes
  them is preferred; suppressing their advisories in repository policy is not allowed.

Re-run the target dependency-path commands and update this record before changing the supported
platform, Tauri line, or release target. Warning acceptance never permits `cargo audit` to report a
vulnerability.
