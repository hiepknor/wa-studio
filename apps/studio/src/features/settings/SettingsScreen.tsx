import { useCallback, useEffect, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
import {
  resolveWorkspaceNavigationDialogCopy,
  useWorkspaceNavigationGuard,
  type WorkspaceNavigationGuard,
} from "@/app/WorkspaceNavigationGuard";
import {
  checkForAppUpdate,
  getAppUpdateState,
  installAppUpdate,
  subscribeAppUpdateProgress,
  type AppUpdateProgress,
  type AppUpdateSnapshot,
} from "@/shared/native/app-updates";
import {
  createManagedRuntimeBackup,
  exportManagedRuntimeRecoveryArchive,
  getManagedRuntimeDiagnostics,
  getManagedRuntimeProvisioningProfile,
  listManagedRuntimeBackups,
  reconfigureManagedRuntime,
  restoreManagedRuntimeBackup,
  restoreManagedRuntimeRecoveryArchive,
  type ManagedRuntimeBackup,
  type ManagedRuntimeDiagnostics,
} from "@/shared/native/managed-runtime";
import { userFacingErrorMessage } from "@/shared/errors/error-message";
import { useLatestOperation } from "@/shared/hooks/useLatestOperation";
import { useSingleFlightOperation } from "@/shared/hooks/useSingleFlightOperation";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { ConfirmationDialog } from "@/shared/ui/ConfirmationDialog";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Tabs, type TabItem } from "@/shared/ui/Tabs";
import { AppUpdateSettings } from "./AppUpdateSettings";
import { BackupRecoverySettings } from "./BackupRecoverySettings";
import { ManagedRuntimeConfigurationPanel } from "./ManagedRuntimeConfigurationPanel";
import { SettingsOverviewPanel } from "./SettingsOverviewPanel";
import type { SettingsTab, SettingsTaskNavigationState } from "./settings-types";
import "./settings.css";

interface SettingsScreenProps {
  checkUpdate?: typeof checkForAppUpdate;
  createBackup?: typeof createManagedRuntimeBackup;
  exportRecoveryArchive?: typeof exportManagedRuntimeRecoveryArchive;
  getDiagnostics?: typeof getManagedRuntimeDiagnostics;
  getUpdateState?: typeof getAppUpdateState;
  installUpdate?: typeof installAppUpdate;
  getProvisioningProfile?: typeof getManagedRuntimeProvisioningProfile;
  listBackups?: typeof listManagedRuntimeBackups;
  restoreBackup?: typeof restoreManagedRuntimeBackup;
  restoreRecoveryArchive?: typeof restoreManagedRuntimeRecoveryArchive;
  saveProvisioningProfile?: typeof reconfigureManagedRuntime;
  subscribeUpdateProgress?: typeof subscribeAppUpdateProgress;
}

const SETTINGS_TABS: readonly TabItem<SettingsTab>[] = [
  { id: "overview", label: "Overview" },
  { id: "connection", label: "Connection" },
  { id: "recovery", label: "Backups & recovery" },
  { id: "updates", label: "Updates" },
];

const CONNECTION_NAVIGATION_GUARD = {
  message: "Unsaved OpenWA endpoint, credential, or live-send changes will be discarded. WA Runtime is not changed.",
  title: "Leave connection changes?",
} as const;

const RECOVERY_DRAFT_NAVIGATION_GUARD = {
  message: "Entered recovery passphrases will be cleared before leaving this task. No archive operation has started.",
  title: "Leave recovery setup?",
} as const;

const RECOVERY_BUSY_NAVIGATION_GUARD = {
  busy: true,
  busyLabel: "Finishing operation…",
  message: "A backup or recovery operation is still running. Keep Settings open until it finishes.",
  settledMessage: "The backup or recovery operation has finished. Continue to the requested destination.",
  settledTitle: "Recovery operation finished",
  title: "Recovery operation in progress",
} as const;

const UPDATE_BUSY_NAVIGATION_GUARD = {
  busy: true,
  busyLabel: "Installing update…",
  message: "WA Studio is installing a signed update and WA Runtime may be paused. Keep Settings open until the operation finishes.",
  settledMessage: "The update installation has finished. Continue to the requested destination.",
  settledTitle: "Update operation finished",
  title: "Update installation in progress",
} as const;

const CLEAN_TASK_NAVIGATION_STATE: SettingsTaskNavigationState = {
  busy: false,
  dirty: false,
};

interface PendingSettingsTab {
  guard: WorkspaceNavigationGuard;
  tab: SettingsTab;
}

export function SettingsScreen({
  checkUpdate = checkForAppUpdate,
  createBackup = createManagedRuntimeBackup,
  exportRecoveryArchive = exportManagedRuntimeRecoveryArchive,
  getDiagnostics = getManagedRuntimeDiagnostics,
  getUpdateState = getAppUpdateState,
  installUpdate = installAppUpdate,
  getProvisioningProfile = getManagedRuntimeProvisioningProfile,
  listBackups = listManagedRuntimeBackups,
  restoreBackup = restoreManagedRuntimeBackup,
  restoreRecoveryArchive = restoreManagedRuntimeRecoveryArchive,
  saveProvisioningProfile = reconfigureManagedRuntime,
  subscribeUpdateProgress = subscribeAppUpdateProgress,
}: SettingsScreenProps = {}) {
  const { managedRuntime } = useRuntimeConnection();
  const [activeTab, setActiveTab] = useState<SettingsTab>("overview");
  const [connectionNavigation, setConnectionNavigation] =
    useState<SettingsTaskNavigationState>(CLEAN_TASK_NAVIGATION_STATE);
  const [recoveryNavigation, setRecoveryNavigation] =
    useState<SettingsTaskNavigationState>(CLEAN_TASK_NAVIGATION_STATE);
  const [updateNavigation, setUpdateNavigation] =
    useState<SettingsTaskNavigationState>(CLEAN_TASK_NAVIGATION_STATE);
  const [pendingTab, setPendingTab] = useState<PendingSettingsTab | null>(null);
  const [backups, setBackups] = useState<ManagedRuntimeBackup[]>([]);
  const [diagnostics, setDiagnostics] = useState<ManagedRuntimeDiagnostics | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<AppUpdateSnapshot | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const runtimeLoad = useLatestOperation();
  const updateLoad = useLatestOperation();
  const refreshOperation = useSingleFlightOperation();
  const settingsNavigationGuard: WorkspaceNavigationGuard | null = connectionNavigation.dirty
    ? connectionNavigation.busy
      ? { ...CONNECTION_NAVIGATION_GUARD, busy: true, busyLabel: "Saving connection…" }
      : CONNECTION_NAVIGATION_GUARD
    : recoveryNavigation.dirty
      ? recoveryNavigation.busy
        ? RECOVERY_BUSY_NAVIGATION_GUARD
        : RECOVERY_DRAFT_NAVIGATION_GUARD
      : updateNavigation.dirty
        ? UPDATE_BUSY_NAVIGATION_GUARD
        : null;
  const settingsNavigationDialogCopy = resolveWorkspaceNavigationDialogCopy(
    settingsNavigationGuard,
    pendingTab?.guard ?? null,
  );
  const settingsNavigationSettled = !settingsNavigationGuard && Boolean(pendingTab?.guard.busy);
  useWorkspaceNavigationGuard(
    settingsNavigationGuard !== null,
    settingsNavigationGuard ?? CONNECTION_NAVIGATION_GUARD,
  );

  const loadRuntime = useCallback(async (): Promise<boolean> => {
    const token = runtimeLoad.begin();
    if (!runtimeLoad.isCurrent(token)) return false;
    setRuntimeLoading(true);
    setRuntimeError(null);
    try {
      const [backupsResult, diagnosticsResult] = await Promise.allSettled([
        listBackups(),
        getDiagnostics(),
      ]);
      if (!runtimeLoad.isCurrent(token)) return false;
      if (backupsResult.status === "fulfilled") setBackups(backupsResult.value);
      if (diagnosticsResult.status === "fulfilled") {
        setDiagnostics(diagnosticsResult.value);
      }
      const failures = [
        backupsResult.status === "rejected"
          ? userFacingErrorMessage(backupsResult.reason, "Could not list Runtime backups.")
          : null,
        diagnosticsResult.status === "rejected"
          ? userFacingErrorMessage(diagnosticsResult.reason, "Could not inspect Runtime diagnostics.")
          : null,
      ].filter((message): message is string => Boolean(message));
      setRuntimeError(failures.length ? failures.join(" ") : null);
      return failures.length === 0;
    } finally {
      if (runtimeLoad.isCurrent(token)) setRuntimeLoading(false);
    }
  }, [getDiagnostics, listBackups, runtimeLoad]);

  const loadUpdates = useCallback(async (): Promise<boolean> => {
    const token = updateLoad.begin();
    if (!updateLoad.isCurrent(token)) return false;
    setUpdateError(null);
    try {
      const next = await getUpdateState();
      if (!updateLoad.isCurrent(token)) return false;
      setUpdateState(next);
      return true;
    } catch (caught) {
      if (!updateLoad.isCurrent(token)) return false;
      setUpdateError(userFacingErrorMessage(caught, "Could not inspect app updates."));
      return false;
    }
  }, [getUpdateState, updateLoad]);

  const checkUpdates = useCallback(async (): Promise<AppUpdateSnapshot> => {
    const token = updateLoad.begin();
    if (!updateLoad.isCurrent(token)) {
      throw new Error("Settings is no longer active.");
    }
    setUpdateError(null);
    try {
      const next = await checkUpdate();
      if (updateLoad.isCurrent(token)) setUpdateState(next);
      return next;
    } catch (caught) {
      if (updateLoad.isCurrent(token)) {
        setUpdateError(userFacingErrorMessage(caught, "Could not check for app updates."));
      }
      throw caught;
    }
  }, [checkUpdate, updateLoad]);

  useEffect(() => {
    void loadRuntime();
    void loadUpdates();
  }, [loadRuntime, loadUpdates]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeUpdateProgress(progress => {
      if (!disposed) setUpdateProgress(progress);
    }).then(listener => {
      if (disposed) listener();
      else unlisten = listener;
    }).catch(caught => {
      if (!disposed) {
        setUpdateError(userFacingErrorMessage(caught, "Could not watch app update progress."));
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [subscribeUpdateProgress]);

  async function refreshAll() {
    const token = refreshOperation.begin();
    if (token === null) return;
    setRefreshing(true);
    try {
      await Promise.all([loadRuntime(), loadUpdates()]);
    } finally {
      if (refreshOperation.complete(token)) setRefreshing(false);
    }
  }

  function requestTab(nextTab: SettingsTab) {
    if (nextTab === activeTab) return;
    if (settingsNavigationGuard) {
      setPendingTab({ guard: settingsNavigationGuard, tab: nextTab });
      return;
    }
    setActiveTab(nextTab);
  }

  function discardSettingsChangesAndNavigate() {
    if (!pendingTab || settingsNavigationGuard?.busy) return;
    setConnectionNavigation(CLEAN_TASK_NAVIGATION_STATE);
    setRecoveryNavigation(CLEAN_TASK_NAVIGATION_STATE);
    setUpdateNavigation(CLEAN_TASK_NAVIGATION_STATE);
    setActiveTab(pendingTab.tab);
    setPendingTab(null);
  }

  const runtimeReady = managedRuntime.phase === "ready";
  const overviewError = [runtimeError, updateError]
    .filter((message): message is string => Boolean(message))
    .join(" ") || null;
  const storageNeedsAttention = diagnostics?.storage.pressure !== undefined
    && diagnostics.storage.pressure !== "normal";
  const tabs = SETTINGS_TABS.map(tab => ({
    ...tab,
    warning: tab.id === "connection"
      ? managedRuntime.phase === "degraded" || managedRuntime.phase === "unavailable"
      : tab.id === "recovery"
        ? Boolean(runtimeError
          || (diagnostics && diagnostics.recoveryFreshness !== "fresh")
          || storageNeedsAttention)
        : tab.id === "updates"
          ? Boolean(updateError || updateState?.pending)
          : Boolean(runtimeError || updateError || storageNeedsAttention),
  }));

  return (
    <div className="settings-screen">
      <PageHeader
        description="Product preferences stay separate from connection, backup, and WA Runtime service controls."
        title="Settings"
        titleId="settings-title"
      />

      <div className="settings-layout">
        <nav aria-label="Settings sections" className="settings-navigation">
          <Tabs
            activeTab={activeTab}
            ariaLabel="Settings sections"
            idPrefix="settings"
            onChange={requestTab}
            orientation="vertical"
            tabs={tabs}
          />
        </nav>

        <div className="settings-content">
          {managedRuntime.phase === "restoring" && (
            <InlineAlert className="settings-notice" indicator title="Restore in progress" tone="warning">
              WA Runtime is paused while the selected data is restored.
            </InlineAlert>
          )}

          <div
            aria-labelledby={`settings-${activeTab}-tab`}
            className="settings-tab-panel"
            id={`settings-${activeTab}-panel`}
            role="tabpanel"
          >
            {activeTab === "overview" && (
              <SettingsOverviewPanel
                diagnostics={diagnostics}
                error={overviewError}
                loading={runtimeLoading}
                managedRuntime={managedRuntime}
                onNavigate={requestTab}
                onRefresh={() => void refreshAll()}
                refreshing={refreshing}
                updateState={updateState}
              />
            )}
            {activeTab === "connection" && (
              <ManagedRuntimeConfigurationPanel
                getProfile={getProvisioningProfile}
                onNavigationStateChange={setConnectionNavigation}
                phase={managedRuntime.phase}
                saveProfile={saveProvisioningProfile}
              />
            )}
            {activeTab === "recovery" && (
              <BackupRecoverySettings
                backups={backups}
                createBackup={createBackup}
                diagnostics={diagnostics}
                exportRecoveryArchive={exportRecoveryArchive}
                loadError={runtimeError}
                loading={runtimeLoading}
                onNavigationStateChange={setRecoveryNavigation}
                onReload={loadRuntime}
                restoreBackup={restoreBackup}
                restoreRecoveryArchive={restoreRecoveryArchive}
                runtimeReady={runtimeReady}
              />
            )}
            {activeTab === "updates" && (
              <AppUpdateSettings
                checkUpdate={checkUpdates}
                error={updateError}
                installUpdate={installUpdate}
                onNavigationStateChange={setUpdateNavigation}
                progress={updateProgress}
                runtimeReady={runtimeReady}
                updateState={updateState}
              />
            )}
          </div>
        </div>
      </div>

      <ConfirmationDialog
        body={settingsNavigationDialogCopy.message}
        busy={Boolean(settingsNavigationGuard?.busy)}
        busyLabel={settingsNavigationGuard?.busyLabel}
        cancelLabel="Keep editing"
        confirmLabel={settingsNavigationGuard ? "Discard and continue" : "Continue"}
        confirmVariant="danger"
        onCancel={() => setPendingTab(null)}
        onConfirm={discardSettingsChangesAndNavigate}
        open={pendingTab !== null}
        title={settingsNavigationSettled
          ? settingsNavigationDialogCopy.title
          : settingsNavigationGuard?.busy
            ? settingsNavigationGuard.title
            : settingsNavigationGuard === RECOVERY_DRAFT_NAVIGATION_GUARD
              ? "Discard recovery setup?"
              : settingsNavigationGuard
                ? "Discard connection changes?"
                : pendingTab?.guard.title ?? "Discard Settings changes?"}
      />
    </div>
  );
}
