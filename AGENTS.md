<!-- CODEGRAPH_START -->
## CodeGraph

This repository is indexed by CodeGraph. Before grep/find or opening files to understand or locate
code, use:

```bash
codegraph explore "<symbols or question>"
```

Run `codegraph sync` after structural edits. The index is machine-local.
<!-- CODEGRAPH_END -->

# Monorepo guidance

## Workspace boundaries

- `apps/studio` owns React UI and the Tauri native supervisor.
- `services/runtime` owns Runtime business logic, persistence, queues, and third-party integrations.
- `packages/runtime-contract` is the only public Runtime API snapshot and generated TypeScript client
  contract. Do not create workspace-local copies.
- `tooling` owns cross-workspace build, packaged E2E, and release orchestration.
- OpenWA is external and pinned by `release/components.json`; do not vendor or modify it here.

Use root npm commands and the single root `package-lock.json`. Do not add sibling-repository path
fallbacks. Preserve Tauri identifier `dev.hiepknor.wastudio` and its existing local data paths.

## Verification

Run `npm run check` after each small refactor. Run `npm run test:integration` for Runtime persistence
or orchestration changes. After controller or DTO changes, regenerate the contract from root and
review generated output. Desktop supervisor, packaging, or lifecycle changes require a debug desktop
build and the packaged managed-Runtime E2E.

Do not hand-edit generated contract files, already-applied SQL migrations, packaged binaries, or
release output under `dist`.
