import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  createManagedRuntimeBackup,
  exportManagedRuntimeRecoveryArchive,
  getManagedRuntimeDiagnostics,
  restoreManagedRuntimeBackup,
  restoreManagedRuntimeRecoveryArchive,
} from "./managed-runtime";

describe("managed Runtime recovery bridge", () => {
  beforeEach(() => invoke.mockReset());

  it("keeps native file paths out of recovery command arguments", async () => {
    invoke.mockResolvedValue(undefined);

    await createManagedRuntimeBackup();
    await getManagedRuntimeDiagnostics();
    await restoreManagedRuntimeBackup("automatic-20.dump.age");
    await exportManagedRuntimeRecoveryArchive("recovery-passphrase");
    await restoreManagedRuntimeRecoveryArchive("recovery-passphrase");

    expect(invoke.mock.calls).toEqual([
      ["create_managed_runtime_backup"],
      ["get_managed_runtime_diagnostics"],
      ["restore_managed_runtime_backup", { backupId: "automatic-20.dump.age" }],
      ["export_managed_runtime_recovery_archive", { passphrase: "recovery-passphrase" }],
      ["restore_managed_runtime_recovery_archive", { passphrase: "recovery-passphrase" }],
    ]);
  });
});
