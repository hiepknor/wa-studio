import { useCallback, useEffect, useState } from "react";

import { useRuntimeConnection } from "@/app/RuntimeConnectionContext";
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
import { Button } from "@/shared/ui/Button";
import { InlineAlert } from "@/shared/ui/InlineAlert";
import { PageHeader } from "@/shared/ui/PageHeader";
import { Tabs, type TabItem } from "@/shared/ui/Tabs";
import { AppUpdateSettings } from "./AppUpdateSettings";
import { BackupRecoverySettings } from "./BackupRecoverySettings";
import { ManagedRuntimeConfigurationPanel } from "./ManagedRuntimeConfigurationPanel";
import { SettingsOverviewPanel } from "./SettingsOverviewPanel";
import type { SettingsTab } from "./settings-types";
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
  const [backups, setBackups] = useState<ManagedRuntimeBackup[]>([]);
  const [diagnostics, setDiagnostics] = useState<ManagedRuntimeDiagnostics | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<AppUpdateSnapshot | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadRuntime = useCallback(async () => {
    setRuntimeLoading(true);
    setRuntimeError(null);
    try {
      const [nextBackups, nextDiagnostics] = await Promise.all([
        listBackups(),
        getDiagnostics(),
      ]);
      setBackups(nextBackups);
      setDiagnostics(nextDiagnostics);
    } catch (caught) {
      setRuntimeError(caught instanceof Error ? caught.message : "Could not inspect Runtime status.");
    } finally {
      setRuntimeLoading(false);
    }
  }, [getDiagnostics, listBackups]);

  const loadUpdates = useCallback(async () => {
    setUpdateError(null);
    try {
      setUpdateState(await getUpdateState());
    } catch (caught) {
      setUpdateError(caught instanceof Error ? caught.message : "Could not inspect app updates.");
    }
  }, [getUpdateState]);

  useEffect(() => {
    void loadRuntime();
    void loadUpdates();
  }, [loadRuntime, loadUpdates]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeUpdateProgress(setUpdateProgress).then(listener => {
      if (disposed) listener();
      else unlisten = listener;
    }).catch(caught => {
      if (!disposed) {
        setUpdateError(caught instanceof Error ? caught.message : "Could not watch app update progress.");
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [subscribeUpdateProgress]);

  async function refreshAll() {
    setRefreshing(true);
    await Promise.all([loadRuntime(), loadUpdates()]);
    setRefreshing(false);
  }

  const runtimeReady = managedRuntime.phase === "ready";
  const tabs = SETTINGS_TABS.map(tab => ({
    ...tab,
    warning: tab.id === "connection"
      ? managedRuntime.phase === "degraded" || managedRuntime.phase === "unavailable"
      : tab.id === "recovery"
        ? Boolean(runtimeError || (diagnostics && diagnostics.recoveryFreshness !== "fresh"))
        : tab.id === "updates"
          ? Boolean(updateError || updateState?.pending)
          : Boolean(runtimeError || updateError),
  }));

  return (
    <div className="settings-screen stack stack-lg">
      <PageHeader
        actions={(
          <Button
            disabled={refreshing || managedRuntime.phase === "restoring"}
            icon="refresh"
            loading={refreshing}
            onClick={() => void refreshAll()}
          >
            Refresh status
          </Button>
        )}
        description="Manage WA Runtime, local data protection, connections, and desktop updates."
        title="Settings"
        titleId="settings-title"
      />

      <nav className="settings-navigation">
        <Tabs
          activeTab={activeTab}
          ariaLabel="Settings sections"
          idPrefix="settings"
          onChange={setActiveTab}
          tabs={tabs}
        />
      </nav>

      {managedRuntime.phase === "restoring" && (
        <InlineAlert indicator title="Restore in progress" tone="warning">
          WA Runtime is paused while the selected data is restored.
        </InlineAlert>
      )}

      <div
        aria-labelledby={`settings-${activeTab}-tab`}
        className="settings-tab-panel"
        id={`settings-${activeTab}-panel`}
        role="tabpanel"
        tabIndex={0}
      >
        {activeTab === "overview" && (
          <SettingsOverviewPanel
            diagnostics={diagnostics}
            error={runtimeError ?? updateError}
            loading={runtimeLoading}
            managedRuntime={managedRuntime}
            onNavigate={setActiveTab}
            updateState={updateState}
          />
        )}
        {activeTab === "connection" && (
          <ManagedRuntimeConfigurationPanel
            getProfile={getProvisioningProfile}
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
            loading={runtimeLoading}
            onReload={loadRuntime}
            restoreBackup={restoreBackup}
            restoreRecoveryArchive={restoreRecoveryArchive}
            runtimeReady={runtimeReady}
          />
        )}
        {activeTab === "updates" && (
          <AppUpdateSettings
            checkUpdate={checkUpdate}
            error={updateError}
            installUpdate={installUpdate}
            onUpdateStateChange={setUpdateState}
            progress={updateProgress}
            runtimeReady={runtimeReady}
            updateState={updateState}
          />
        )}
      </div>
    </div>
  );
}
