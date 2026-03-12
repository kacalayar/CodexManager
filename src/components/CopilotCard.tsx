import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useI18n } from "../i18n";
import {
  detectCopilotApi,
  getConfig,
  getCopilotStatus,
  getAllCopilotStatuses,
  onCopilotAuthRequired,
  onCopilotStatusChanged,
  onCopilotStatusesChanged,
  saveConfig,
  startCopilotInstance,
  stopCopilotInstance,
} from "../lib/tauri";
import { toastStore } from "../stores/toast";
import { Button } from "./ui";
import { Switch } from "./ui/Switch";

import type {
  CopilotApiDetection,
  CopilotConfig,
  CopilotInstanceConfig,
  CopilotStatus,
} from "../lib/tauri";

interface CopilotCardProps {
  config: CopilotConfig;
  onConfigChange: (config: CopilotConfig) => void;
  proxyRunning: boolean;
}

// Default instance template
function createDefaultInstance(id: string, port: number): CopilotInstanceConfig {
  return {
    accountType: "individual",
    enabled: false,
    githubToken: "",
    githubUsername: "",
    id,
    name: id === "default" ? "Personal" : `Account ${id}`,
    port,
    rateLimit: undefined,
    rateLimitWait: false,
  };
}

export function CopilotCard(props: CopilotCardProps) {
  const { t } = useI18n();

  // Get instances from config
  const instances = createMemo(() => {
    if (props.config.instances.length === 0) {
      return [createDefaultInstance("default", 4141)];
    }
    return props.config.instances;
  });

  // Status map for all instances
  const [statuses, setStatuses] = createSignal<Record<string, CopilotStatus>>({});
  const [startingInstances, setStartingInstances] = createSignal<Set<string>>(new Set());
  const [stoppingInstances, setStoppingInstances] = createSignal<Set<string>>(new Set());
  const [expandedInstances, setExpandedInstances] = createSignal<Set<string>>(new Set());
  const [apiDetection, setApiDetection] = createSignal<CopilotApiDetection | null>(null);

  // Helper to get status for an instance
  const getStatus = (instanceId: string): CopilotStatus => {
    return (
      statuses()[instanceId] || {
        authenticated: false,
        endpoint: `http://localhost:4141`,
        id: instanceId,
        port: 4141,
        running: false,
      }
    );
  };

  onMount(async () => {
    // Load initial status
    try {
      const allStatuses = await getAllCopilotStatuses();
      if (allStatuses && allStatuses.instances) {
        setStatuses(allStatuses.instances);
      }
    } catch (error) {
      console.error("Failed to get copilot status:", error);
      // Fallback to single status
      try {
        const initialStatus = await getCopilotStatus();
        setStatuses({ [initialStatus.id || "default"]: initialStatus });
      } catch {
        // Ignore
      }
    }

    // Detect if copilot-api is installed
    try {
      const detection = await detectCopilotApi();
      setApiDetection(detection);
    } catch (error) {
      console.error("Failed to detect copilot-api:", error);
    }

    // Subscribe to status changes
    const unlistenStatus = await onCopilotStatusChanged((newStatus) => {
      setStatuses((prev) => ({ ...prev, [newStatus.id || "default"]: newStatus }));
    });

    const unlistenStatuses = await onCopilotStatusesChanged((nextStatuses) => {
      setStatuses(nextStatuses.instances);
    });

    // Subscribe to auth required events
    const unlistenAuth = await onCopilotAuthRequired((event) => {
      // Extract the URL from the message if present
      const urlMatch = event.message.match(/https:\/\/github\.com\/login\/device/);
      if (urlMatch) {
        toastStore.info(
          t("copilot.toasts.githubAuthenticationRequired"),
          t("copilot.toasts.checkTerminalForDeviceCode"),
        );
      }
    });

    // Poll for health status when running but not authenticated
    const healthPollInterval = setInterval(async () => {
      try {
        const nextStatuses = await getAllCopilotStatuses();
        if (Object.keys(nextStatuses.instances).length > 0) {
          setStatuses(nextStatuses.instances);
        }
      } catch (error) {
        console.error("Health check failed:", error);
      }
    }, 2000);

    onCleanup(() => {
      unlistenStatus();
      unlistenStatuses();
      unlistenAuth();
      clearInterval(healthPollInterval);
    });
  });

  // Helper to update instance in config
  const updateInstance = (instanceId: string, updates: Partial<CopilotInstanceConfig>) => {
    const newInstances = [...props.config.instances];
    const idx = newInstances.findIndex((i) => i.id === instanceId);
    if (idx >= 0) {
      newInstances[idx] = { ...newInstances[idx], ...updates };
      props.onConfigChange({ ...props.config, instances: newInstances });
    }
  };

  const handleToggleEnabled = async (instanceId: string, enabled: boolean) => {
    const newInstances = instances().map((i) => (i.id === instanceId ? { ...i, enabled } : i));
    const newConfig = { ...props.config, instances: newInstances };
    props.onConfigChange(newConfig);

    // Save to backend
    try {
      const fullConfig = await getConfig();
      await saveConfig({ ...fullConfig, copilot: newConfig });

      if (enabled && props.proxyRunning) {
        // Auto-start copilot when enabled
        await handleStart(instanceId);
      } else if (!enabled && getStatus(instanceId).running) {
        // Auto-stop copilot when disabled
        await handleStop(instanceId);
      }
    } catch (error) {
      console.error("Failed to save copilot config:", error);
      toastStore.error(t("copilot.toasts.failedToSaveSettings"), String(error));
    }
  };

  const handleStart = async (instanceId: string) => {
    const status = getStatus(instanceId);
    if (startingInstances().has(instanceId) || status.running) {
      return;
    }
    setStartingInstances((prev) => new Set(prev).add(instanceId));

    try {
      const newStatus = await startCopilotInstance(instanceId);
      setStatuses((prev) => ({ ...prev, [instanceId]: newStatus }));

      if (newStatus.authenticated) {
        toastStore.success(
          t("copilot.toasts.githubCopilotConnected"),
          t("copilot.toasts.modelsNowAvailableThroughProxy"),
        );
      } else {
        toastStore.info(
          t("copilot.toasts.copilotStarting"),
          t("copilot.toasts.completeGithubAuthenticationIfPrompted"),
        );
      }
    } catch (error) {
      console.error("Failed to start copilot:", error);
      const errorMsg = String(error);
      toastStore.error(t("copilot.toasts.failedToStartCopilot"), errorMsg);
    } finally {
      setStartingInstances((prev) => {
        const next = new Set(prev);
        next.delete(instanceId);
        return next;
      });
    }
  };

  const handleStop = async (instanceId: string) => {
    const status = getStatus(instanceId);
    if (stoppingInstances().has(instanceId) || !status.running) {
      return;
    }
    setStoppingInstances((prev) => new Set(prev).add(instanceId));

    try {
      const newStatus = await stopCopilotInstance(instanceId);
      setStatuses((prev) => ({ ...prev, [instanceId]: newStatus }));
      toastStore.info(t("copilot.toasts.copilotStopped"));
    } catch (error) {
      console.error("Failed to stop copilot:", error);
      toastStore.error(t("copilot.toasts.failedToStopCopilot"), String(error));
    } finally {
      setStoppingInstances((prev) => {
        const next = new Set(prev);
        next.delete(instanceId);
        return next;
      });
    }
  };

  const handleOpenGitHubAuth = () => {
    window.open("https://github.com/login/device", "_blank");
  };

  const isConnected = (instanceId: string) => {
    const s = getStatus(instanceId);
    return s.running && s.authenticated;
  };
  const isRunningNotAuth = (instanceId: string) => {
    const s = getStatus(instanceId);
    return s.running && !s.authenticated;
  };

  const addNewInstance = async () => {
    const existingPorts = instances().map((i) => i.port);
    let newPort = 4142;
    while (existingPorts.includes(newPort)) {
      newPort++;
    }
    const newId = `instance-${Date.now()}`;
    const newInstance = createDefaultInstance(newId, newPort);
    newInstance.name = `Account ${instances().length + 1}`;

    const newInstances = [...instances(), newInstance];
    const newConfig = { ...props.config, instances: newInstances };
    props.onConfigChange(newConfig);

    // Save to backend
    try {
      const fullConfig = await getConfig();
      await saveConfig({ ...fullConfig, copilot: newConfig });
      toastStore.success(t("copilot.toasts.accountAdded") || "Account added");
    } catch (error) {
      console.error("Failed to save copilot config:", error);
      toastStore.error(t("copilot.toasts.failedToSaveSettings"), String(error));
    }
  };

  const removeInstance = async (instanceId: string) => {
    if (instances().length <= 1) {
      toastStore.error(
        t("copilot.toasts.cannotRemoveLastAccount") || "Cannot remove the last account",
      );
      return;
    }

    // Stop if running
    const status = getStatus(instanceId);
    if (status.running) {
      await handleStop(instanceId);
    }

    const newInstances = instances().filter((i) => i.id !== instanceId);
    const newConfig = { ...props.config, instances: newInstances };
    props.onConfigChange(newConfig);

    // Save to backend
    try {
      const fullConfig = await getConfig();
      await saveConfig({ ...fullConfig, copilot: newConfig });
      toastStore.success(t("copilot.toasts.accountRemoved") || "Account removed");
    } catch (error) {
      console.error("Failed to save copilot config:", error);
      toastStore.error(t("copilot.toasts.failedToSaveSettings"), String(error));
    }
  };

  const toggleExpanded = (instanceId: string) => {
    setExpandedInstances((prev) => {
      const next = new Set(prev);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  };

  return (
    <div class="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      {/* Header */}
      <div class="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
        <div class="flex items-center gap-3">
          <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500 to-blue-600">
            <img
              alt="GitHub Copilot"
              class="h-5 w-5 text-white"
              src="/logos/copilot.svg"
              style={{ filter: "brightness(0) invert(1)" }}
            />
          </div>
          <div>
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              GitHub Copilot
            </span>
            <p class="text-xs text-gray-500 dark:text-gray-400">{t("copilot.subtitle")}</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-500 dark:text-gray-400">
            {instances().filter((i) => i.enabled).length} / {instances().length}{" "}
            {t("copilot.accountsActive") || "active"}
          </span>
          <Button onClick={addNewInstance} size="sm" variant="secondary">
            <svg class="mr-1 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                d="M12 4v16m8-8H4"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
              />
            </svg>
            {t("copilot.actions.addAccount") || "Add Account"}
          </Button>
        </div>
      </div>

      {/* Instances List */}
      <div class="divide-y divide-gray-100 dark:divide-gray-700">
        <For each={instances()}>
          {(instance) => {
            const instanceStatus = () => getStatus(instance.id);
            const isStarting = () => startingInstances().has(instance.id);
            const isStopping = () => stoppingInstances().has(instance.id);
            const isExpanded = () => expandedInstances().has(instance.id);

            return (
              <div class="p-4">
                {/* Instance header */}
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <div class="flex items-center gap-2">
                      <input
                        class="w-32 border-0 bg-transparent p-0 text-sm font-medium text-gray-900 focus:outline-none focus:ring-0 dark:text-gray-100"
                        onInput={(e) =>
                          updateInstance(instance.id, { name: e.currentTarget.value })
                        }
                        placeholder={t("copilot.accountName") || "Account name"}
                        type="text"
                        value={instance.name}
                      />
                    </div>
                    {/* Status indicator */}
                    <div class="flex items-center gap-1.5">
                      <div
                        class={`h-2 w-2 rounded-full ${
                          isConnected(instance.id)
                            ? "bg-green-500"
                            : isRunningNotAuth(instance.id)
                              ? "animate-pulse bg-amber-500"
                              : instanceStatus().running
                                ? "bg-blue-500"
                                : "bg-gray-400"
                        }`}
                      />
                      <span class="text-xs text-gray-500 dark:text-gray-400">
                        {isConnected(instance.id)
                          ? instanceStatus().githubUsername || t("copilot.status.connected")
                          : isRunningNotAuth(instance.id)
                            ? t("copilot.status.authenticating")
                            : instanceStatus().running
                              ? t("copilot.status.running")
                              : t("copilot.status.offline")}
                      </span>
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    {/* Start/Stop buttons */}
                    <Show when={instance.enabled && !instanceStatus().running}>
                      <Button
                        disabled={isStarting() || !props.proxyRunning}
                        onClick={() => handleStart(instance.id)}
                        size="sm"
                        variant="primary"
                      >
                        {isStarting()
                          ? t("copilot.actions.starting")
                          : t("copilot.actions.startCopilot")}
                      </Button>
                    </Show>
                    <Show when={instance.enabled && instanceStatus().running}>
                      <Button
                        disabled={isStopping()}
                        onClick={() => handleStop(instance.id)}
                        size="sm"
                        variant="secondary"
                      >
                        {isStopping() ? t("copilot.actions.stopping") : t("copilot.actions.stop")}
                      </Button>
                    </Show>
                    {/* Enable switch */}
                    <Switch
                      checked={instance.enabled}
                      onChange={(checked) => handleToggleEnabled(instance.id, checked)}
                    />
                    {/* Expand/collapse */}
                    <button
                      class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                      onClick={() => toggleExpanded(instance.id)}
                      title={t("copilot.actions.advancedSettings")}
                    >
                      <svg
                        class={`h-4 w-4 transition-transform ${isExpanded() ? "rotate-180" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          d="M19 9l-7 7-7-7"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                        />
                      </svg>
                    </button>
                    {/* Remove button */}
                    <Show when={instances().length > 1}>
                      <button
                        class="rounded-lg p-1.5 text-gray-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/30 dark:hover:text-red-400"
                        onClick={() => removeInstance(instance.id)}
                        title={t("copilot.actions.removeAccount") || "Remove account"}
                      >
                        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                          />
                        </svg>
                      </button>
                    </Show>
                  </div>
                </div>

                {/* Auth required message for this instance */}
                <Show when={instance.enabled && isRunningNotAuth(instance.id)}>
                  <div class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-900/20">
                    <div class="flex items-center gap-2">
                      <svg
                        class="h-4 w-4 text-amber-600 dark:text-amber-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                        />
                      </svg>
                      <span class="text-xs text-amber-700 dark:text-amber-300">
                        {t("copilot.authHelpDescription")}
                      </span>
                      <Button onClick={handleOpenGitHubAuth} size="sm" variant="secondary">
                        {t("copilot.actions.openGithubAuthentication")}
                      </Button>
                    </div>
                  </div>
                </Show>

                {/* Expanded settings */}
                <Show when={isExpanded()}>
                  <div class="mt-3 space-y-3 border-t border-gray-100 pt-3 dark:border-gray-700">
                    <div class="grid grid-cols-2 gap-3">
                      <div>
                        <label class="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                          {t("copilot.port")}
                        </label>
                        <input
                          class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                          onInput={(e) =>
                            updateInstance(instance.id, {
                              port: Number.parseInt(e.currentTarget.value) || 4141,
                            })
                          }
                          type="number"
                          value={instance.port}
                        />
                      </div>
                      <div>
                        <label class="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                          {t("copilot.accountType")}
                        </label>
                        <select
                          class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                          onChange={(e) =>
                            updateInstance(instance.id, { accountType: e.currentTarget.value })
                          }
                          value={instance.accountType}
                        >
                          <option value="individual">{t("copilot.accountTypes.individual")}</option>
                          <option value="business">{t("copilot.accountTypes.business")}</option>
                          <option value="enterprise">{t("copilot.accountTypes.enterprise")}</option>
                        </select>
                      </div>
                    </div>
                    <div class="flex items-center justify-between">
                      <div>
                        <label class="block text-xs font-medium text-gray-700 dark:text-gray-300">
                          {t("copilot.rateLimitWait")}
                        </label>
                        <p class="text-xs text-gray-500 dark:text-gray-400">
                          {t("copilot.rateLimitWaitDescription")}
                        </p>
                      </div>
                      <Switch
                        checked={instance.rateLimitWait}
                        onChange={(checked) =>
                          updateInstance(instance.id, { rateLimitWait: checked })
                        }
                      />
                    </div>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      {/* Installation status & warnings */}
      <div class="border-t border-gray-100 p-4 dark:border-gray-700">
        <Show when={!props.proxyRunning}>
          <p class="text-xs text-amber-600 dark:text-amber-400">
            {t("copilot.startProxyFirstToUseCopilot")}
          </p>
        </Show>

        <Show when={apiDetection()}>
          {(detection) => (
            <Show when={!detection().nodeAvailable}>
              <div class="rounded-lg border border-red-200 bg-red-50 p-2 dark:border-red-800 dark:bg-red-900/20">
                <div class="flex items-center gap-2 text-red-700 dark:text-red-300">
                  <span class="text-xs">
                    {t("copilot.nodeJsRequired")} - {t("copilot.installNodeJsFrom")} nodejs.org
                  </span>
                </div>
              </div>
            </Show>
          )}
        </Show>

        <Show when={apiDetection()?.installed}>
          <div class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <svg
              class="h-3.5 w-3.5 text-green-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                d="M5 13l4 4L19 7"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
              />
            </svg>
            <span>
              copilot-api {apiDetection()?.version ? `v${apiDetection()?.version}` : ""}{" "}
              {t("copilot.installed")}
            </span>
          </div>
        </Show>
      </div>
    </div>
  );
}
