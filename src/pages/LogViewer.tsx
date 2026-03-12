import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/ui";
import { useI18n } from "../i18n";
import {
  clearLogs,
  getLogs,
  getRequestErrorLogContent,
  getRequestErrorLogs,
  type LogEntry,
} from "../lib/tauri";
import { onRequestLog, type RequestLog, getProxyRequestLogs } from "../lib/tauri";
import { appStore } from "../stores/app";
import { toastStore } from "../stores/toast";

// Log level colors
const levelColors: Record<string, string> = {
  DEBUG: "text-gray-500 bg-gray-500/10",
  ERROR: "text-red-500 bg-red-500/10",
  INFO: "text-blue-500 bg-blue-500/10",
  TRACE: "text-gray-400 bg-gray-400/10",
  WARN: "text-yellow-500 bg-yellow-500/10",
};

// Performance: limit displayed logs, load more on demand
const INITIAL_LOG_FETCH = 200;
const DISPLAY_CHUNK_SIZE = 100;
const MAX_REALTIME_REQUESTS = 500;

type LogTab = "requests" | "server" | "errors";
type StatusFilter = "all" | "success" | "error";

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return "text-green-500 bg-green-500/10";
  if (status >= 400 && status < 500) return "text-yellow-500 bg-yellow-500/10";
  if (status >= 500) return "text-red-500 bg-red-500/10";
  return "text-gray-500 bg-gray-500/10";
}

export function LogViewerPage() {
  const { t } = useI18n();
  const { proxyStatus } = appStore;
  const [activeTab, setActiveTab] = createSignal<LogTab>("requests");
  const [logs, setLogs] = createSignal<LogEntry[]>([]);
  const [loading, setLoading] = createSignal(true); // Start true for immediate skeleton
  const [initialLoad, setInitialLoad] = createSignal(true);
  const [autoRefresh, setAutoRefresh] = createSignal(false);
  const [filter, setFilter] = createSignal<string>("all");
  const [search, setSearch] = createSignal("");
  const [showClearConfirm, setShowClearConfirm] = createSignal(false);
  const [displayLimit, setDisplayLimit] = createSignal(DISPLAY_CHUNK_SIZE);

  // Realtime request log state
  const [requestLogs, setRequestLogs] = createSignal<RequestLog[]>([]);
  const [requestSearch, setRequestSearch] = createSignal("");
  const [statusFilter, setStatusFilter] = createSignal<StatusFilter>("all");
  const [requestLoading, setRequestLoading] = createSignal(true);
  const [autoScroll, setAutoScroll] = createSignal(true);
  let requestTableRef: HTMLDivElement | undefined;
  let unlistenRequestLog: (() => void) | null = null;

  // Error logs state
  const [errorLogFiles, setErrorLogFiles] = createSignal<string[]>([]);
  const [selectedErrorLog, setSelectedErrorLog] = createSignal<string>("");
  const [errorLogContent, setErrorLogContent] = createSignal<string>("");
  const [loadingErrorLogs, setLoadingErrorLogs] = createSignal(false);

  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  let logContainerRef: HTMLDivElement | undefined;
  let prevRunning = false;

  // Load logs and request history on mount
  onMount(() => {
    prevRunning = proxyStatus().running;
    if (prevRunning) {
      loadLogs();
      loadRequestHistory();
      startRequestListener();
    } else {
      setLoading(false);
      setInitialLoad(false);
      setRequestLoading(false);
    }
  });

  // React to proxy status changes (only when running state actually changes)
  createEffect(() => {
    const running = proxyStatus().running;

    if (running && !prevRunning) {
      loadLogs();
      loadRequestHistory();
      startRequestListener();
    } else if (!running && prevRunning) {
      setLogs([]);
      setLoading(false);
      setInitialLoad(false);
      stopRequestListener();
    }
    prevRunning = running;
  });

  // Auto-refresh effect - only when explicitly enabled (30 second interval)
  createEffect(() => {
    // Clean up previous interval
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }

    if (autoRefresh() && proxyStatus().running) {
      refreshInterval = setInterval(loadLogs, 30_000);
    }
  });

  onCleanup(() => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
    stopRequestListener();
  });

  const loadRequestHistory = async () => {
    setRequestLoading(true);
    try {
      // Fetch parsed request logs directly from the Go backend's logs API
      const serverLogs = await getProxyRequestLogs(2000);
      setRequestLogs(serverLogs.slice(-MAX_REALTIME_REQUESTS));
    } catch (error) {
      console.error("Failed to load request history:", error);
    } finally {
      setRequestLoading(false);
    }
  };

  const startRequestListener = async () => {
    stopRequestListener();
    try {
      const unlisten = await onRequestLog((log) => {
        setRequestLogs((prev) => {
          const updated = [...prev, log];
          if (updated.length > MAX_REALTIME_REQUESTS) {
            return updated.slice(-MAX_REALTIME_REQUESTS);
          }
          return updated;
        });
        if (autoScroll() && requestTableRef) {
          requestAnimationFrame(() => {
            requestTableRef!.scrollTop = 0;
          });
        }
      });
      unlistenRequestLog = unlisten;
    } catch (error) {
      console.error("Failed to start request listener:", error);
    }
  };

  const stopRequestListener = () => {
    if (unlistenRequestLog) {
      unlistenRequestLog();
      unlistenRequestLog = null;
    }
  };

  const filteredRequestLogs = createMemo(() => {
    let result = requestLogs();
    const sf = statusFilter();
    if (sf === "success") {
      result = result.filter((r) => r.status >= 200 && r.status < 400);
    } else if (sf === "error") {
      result = result.filter((r) => r.status >= 400);
    }
    const term = requestSearch().toLowerCase();
    if (term) {
      result = result.filter(
        (r) =>
          r.model.toLowerCase().includes(term) ||
          r.path.toLowerCase().includes(term) ||
          r.provider.toLowerCase().includes(term) ||
          (r.account && r.account.toLowerCase().includes(term)),
      );
    }
    return [...result].reverse();
  });

  const clearRequestLogs = () => {
    setRequestLogs([]);
  };

  const loadLogs = async () => {
    // Don't block on subsequent loads (allow concurrent refresh indicator)
    const isFirstLoad = initialLoad();
    if (!isFirstLoad && loading()) {
      return;
    }

    setLoading(true);
    try {
      const result = await getLogs(INITIAL_LOG_FETCH);
      setLogs(result);
      setDisplayLimit(DISPLAY_CHUNK_SIZE); // Reset display limit on fresh load
      // Auto-scroll to bottom (use requestAnimationFrame for smoother UX)
      if (logContainerRef) {
        requestAnimationFrame(() => {
          logContainerRef!.scrollTop = logContainerRef!.scrollHeight;
        });
      }
    } catch (error) {
      toastStore.error(t("logs.toasts.failedToLoadLogs"), String(error));
    } finally {
      setLoading(false);
      setInitialLoad(false);
    }
  };

  // Computed: filtered logs with display limit
  const filteredLogs = createMemo(() => {
    let result = logs();

    // Filter by level
    if (filter() !== "all") {
      result = result.filter((log) => log.level.toUpperCase() === filter().toUpperCase());
    }

    // Filter by search
    const searchTerm = search().toLowerCase();
    if (searchTerm) {
      result = result.filter((log) => log.message.toLowerCase().includes(searchTerm));
    }

    return result;
  });

  // Display limited subset for performance
  const displayedLogs = createMemo(() => {
    const all = filteredLogs();
    const limit = displayLimit();
    // Show most recent logs (end of array), up to limit
    if (all.length <= limit) {
      return all;
    }
    return all.slice(-limit);
  });

  const hasMoreLogs = createMemo(() => filteredLogs().length > displayLimit());

  const loadMoreLogs = () => {
    setDisplayLimit((prev) => prev + DISPLAY_CHUNK_SIZE);
  };

  const handleClear = async () => {
    try {
      await clearLogs();
      setLogs([]);
      setShowClearConfirm(false);
      toastStore.success(t("logs.toasts.logsCleared"));
    } catch (error) {
      toastStore.error(t("logs.toasts.failedToClearLogs"), String(error));
    }
  };

  // Error logs handlers
  const loadErrorLogFiles = async () => {
    if (!proxyStatus().running) {
      return;
    }
    // Skip if already loaded (cache)
    if (errorLogFiles().length > 0) {
      return;
    }

    setLoadingErrorLogs(true);
    try {
      const files = await getRequestErrorLogs();
      setErrorLogFiles(files);
      // Select the most recent file by default
      if (files.length > 0 && !selectedErrorLog()) {
        setSelectedErrorLog(files[0]);
        await loadErrorLogContent(files[0]);
      }
    } catch (error) {
      console.error("Failed to load error log files:", error);
      toastStore.error(t("logs.toasts.failedToLoadErrorLog"), String(error));
    } finally {
      setLoadingErrorLogs(false);
    }
  };

  const loadErrorLogContent = async (filename: string) => {
    if (!filename) {
      return;
    }
    setLoadingErrorLogs(true);
    try {
      const content = await getRequestErrorLogContent(filename);
      setErrorLogContent(content);
    } catch (error) {
      toastStore.error(t("logs.toasts.failedToLoadErrorLog"), String(error));
      setErrorLogContent("");
    } finally {
      setLoadingErrorLogs(false);
    }
  };

  const handleSelectErrorLog = async (filename: string) => {
    setSelectedErrorLog(filename);
    await loadErrorLogContent(filename);
  };

  // Load error logs when switching to error tab
  createEffect(() => {
    if (activeTab() === "errors" && proxyStatus().running) {
      loadErrorLogFiles();
    }
  });

  const handleDownload = () => {
    const content = logs()
      .map((log) => {
        const ts = log.timestamp ? `${log.timestamp} ` : "";
        return `${ts}[${log.level}] ${log.message}`;
      })
      .join("\n");

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `proxypal-logs-${new Date().toISOString().split("T")[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastStore.success(t("logs.toasts.logsDownloaded"));
  };

  const logCounts = () => {
    const counts: Record<string, number> = {
      all: logs().length,
      DEBUG: 0,
      ERROR: 0,
      INFO: 0,
      WARN: 0,
    };
    logs().forEach((log) => {
      const level = log.level.toUpperCase();
      if (counts[level] !== undefined) {
        counts[level]++;
      }
    });
    return counts;
  };

  return (
    <div class="flex min-h-screen flex-col bg-white dark:bg-gray-900">
      {/* Header */}
      <header class="sticky top-0 z-10 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900 sm:px-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 sm:gap-3">
            <h1 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t("logs.title")}
            </h1>

            {/* Tab switcher */}
            <div class="ml-2 flex items-center gap-1 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
              <button
                class={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  activeTab() === "requests"
                    ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                    : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                }`}
                onClick={() => setActiveTab("requests")}
              >
                {t("logs.tabs.requests")}
              </button>
              <button
                class={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  activeTab() === "server"
                    ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                    : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                }`}
                onClick={() => setActiveTab("server")}
              >
                {t("logs.tabs.server")}
              </button>
              <button
                class={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  activeTab() === "errors"
                    ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                    : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                }`}
                onClick={() => setActiveTab("errors")}
              >
                {t("logs.tabs.errors")}
              </button>
            </div>

            <Show when={loading() || loadingErrorLogs()}>
              <span class="ml-2 flex items-center gap-1 text-xs text-gray-400">
                <svg class="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle
                    class="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="4"
                  />
                  <path
                    class="opacity-75"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    fill="currentColor"
                  />
                </svg>
                {t("common.loading")}
              </span>
            </Show>
          </div>

          <div class="flex items-center gap-2">
            {/* Server/Error tab controls - only show when not on requests tab */}
            <Show when={activeTab() !== "requests"}>
              {/* Auto-refresh toggle - play/pause icon */}
              <button
                class={`rounded-lg p-2 transition-colors ${
                  autoRefresh()
                    ? "bg-brand-500/20 text-brand-500"
                    : "text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                }`}
                onClick={() => setAutoRefresh(!autoRefresh())}
                title={
                  autoRefresh()
                    ? t("logs.actions.stopAutoRefresh")
                    : t("logs.actions.startAutoRefresh")
                }
              >
                <Show
                  fallback={
                    /* Play icon when OFF */
                    <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  }
                  when={autoRefresh()}
                >
                  {/* Pause icon when ON */}
                  <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                </Show>
              </button>

              {/* Manual refresh button */}
              <button
                class="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                disabled={loading()}
                onClick={loadLogs}
                title={t("logs.actions.refreshNow")}
              >
                <svg
                  class={`h-5 w-5 ${loading() ? "animate-spin" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                  />
                </svg>
              </button>

              {/* Download button */}
              <Show when={logs().length > 0}>
                <button
                  class="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                  onClick={handleDownload}
                  title={t("logs.actions.downloadLogs")}
                >
                  <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                    />
                  </svg>
                </button>

                {/* Clear button */}
                <Button
                  class="text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                  onClick={() => setShowClearConfirm(true)}
                  size="sm"
                  variant="ghost"
                >
                  {t("logs.actions.clear")}
                </Button>
              </Show>
            </Show>
          </div>
        </div>
      </header>

      {/* Content */}
      <main class="flex flex-1 flex-col overflow-hidden">
        {/* Proxy not running warning */}
        <Show when={!proxyStatus().running}>
          <div class="flex flex-1 items-center justify-center p-4">
            <EmptyState
              description={t("logs.proxyNotRunningDescription")}
              icon={
                <svg class="h-10 w-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="1.5"
                  />
                </svg>
              }
              title={t("logs.proxyNotRunning")}
            />
          </div>
        </Show>

        <Show when={proxyStatus().running}>
          {/* Realtime Requests Tab */}
          <Show when={activeTab() === "requests"}>
            {/* Filters */}
            <div class="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-2 dark:border-gray-800 sm:px-6">
              <div class="flex items-center gap-1">
                <For
                  each={[
                    { id: "all" as StatusFilter, label: t("logs.requests.allStatuses") },
                    { id: "success" as StatusFilter, label: t("logs.requests.successOnly") },
                    { id: "error" as StatusFilter, label: t("logs.requests.errorOnly") },
                  ]}
                >
                  {(item) => (
                    <button
                      class={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                        statusFilter() === item.id
                          ? "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
                          : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                      }`}
                      onClick={() => setStatusFilter(item.id)}
                    >
                      {item.label}
                    </button>
                  )}
                </For>
              </div>

              <div class="max-w-xs flex-1">
                <input
                  class="w-full rounded-lg border border-gray-200 bg-gray-100 px-3 py-1.5 text-sm focus:border-transparent focus:ring-2 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800"
                  onInput={(e) => setRequestSearch(e.currentTarget.value)}
                  placeholder={t("logs.searchPlaceholder")}
                  type="text"
                  value={requestSearch()}
                />
              </div>

              <div class="ml-auto flex items-center gap-2">
                <span class="text-xs tabular-nums text-gray-400">
                  {t("logs.requests.totalRequests", { count: filteredRequestLogs().length })}
                </span>
                <button
                  class={`rounded-lg p-1.5 text-xs transition-colors ${
                    autoScroll()
                      ? "bg-brand-500/20 text-brand-500"
                      : "text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                  onClick={() => setAutoScroll(!autoScroll())}
                  title="Auto-scroll"
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M19 14l-7 7m0 0l-7-7m7 7V3" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" />
                  </svg>
                </button>
                <Show when={requestLogs().length > 0}>
                  <button
                    class="rounded-lg px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-900/20"
                    onClick={clearRequestLogs}
                  >
                    {t("logs.actions.clear")}
                  </button>
                </Show>
              </div>
            </div>

            {/* Requests table */}
            <div class="flex-1 overflow-y-auto" ref={requestTableRef}>
              <Show when={requestLoading()}>
                <div class="space-y-1 p-4">
                  <For each={Array(8).fill(0)}>
                    {() => (
                      <div class="flex animate-pulse items-center gap-3 rounded px-2 py-2">
                        <div class="h-4 w-16 rounded bg-gray-200 dark:bg-gray-700" />
                        <div class="h-4 w-20 rounded bg-gray-200 dark:bg-gray-700" />
                        <div class="h-4 w-32 rounded bg-gray-200 dark:bg-gray-700" />
                        <div class="h-4 w-12 rounded bg-gray-200 dark:bg-gray-700" />
                        <div class="h-4 flex-1 rounded bg-gray-200 dark:bg-gray-700" />
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={!requestLoading()}>
                <Show
                  fallback={
                    <div class="flex h-full items-center justify-center">
                      <EmptyState
                        description={
                          requestSearch() || statusFilter() !== "all"
                            ? t("logs.requests.noResults")
                            : t("logs.requests.emptyDescription")
                        }
                        icon={
                          <svg class="h-10 w-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path d="M13 10V3L4 14h7v7l9-11h-7z" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" />
                          </svg>
                        }
                        title={t("logs.requests.empty")}
                      />
                    </div>
                  }
                  when={filteredRequestLogs().length > 0}
                >
                  <table class="w-full text-xs">
                    <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-gray-800/90">
                      <tr class="text-left text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        <th class="px-3 py-2">{t("logs.requests.time")}</th>
                        <th class="px-3 py-2">{t("logs.requests.status")}</th>
                        <th class="px-3 py-2">{t("logs.requests.method")}</th>
                        <th class="px-3 py-2">{t("logs.requests.model")}</th>
                        <th class="px-3 py-2">{t("logs.requests.account")}</th>
                        <th class="px-3 py-2">{t("logs.requests.path")}</th>
                        <th class="px-3 py-2 text-right">{t("logs.requests.duration")}</th>
                        <th class="px-3 py-2 text-right">{t("logs.requests.tokensIn")}</th>
                        <th class="px-3 py-2 text-right">{t("logs.requests.tokensOut")}</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                      <For each={filteredRequestLogs()}>
                        {(req) => (
                          <tr class="transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50">
                            <td class="whitespace-nowrap px-3 py-1.5 tabular-nums text-gray-500 dark:text-gray-400" title={new Date(req.timestamp).toLocaleString()}>
                              <span class="text-gray-400 dark:text-gray-500">{formatDate(req.timestamp)}</span>{" "}
                              {formatTimestamp(req.timestamp)}
                            </td>
                            <td class="px-3 py-1.5">
                              <span class={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${statusColor(req.status)}`}>
                                {req.status}
                              </span>
                            </td>
                            <td class="px-3 py-1.5 font-mono text-gray-700 dark:text-gray-300">{req.method}</td>
                            <td class="max-w-[180px] truncate px-3 py-1.5 font-mono text-gray-900 dark:text-gray-100" title={req.model}>
                              {req.model !== "unknown" ? req.model : "-"}
                            </td>
                            <td class="max-w-[160px] truncate px-3 py-1.5 text-gray-600 dark:text-gray-400" title={req.account || ""}>
                              {req.account ? (
                                <span class="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                                  {req.account}
                                </span>
                              ) : (
                                <span class="text-gray-300 dark:text-gray-600">-</span>
                              )}
                            </td>
                            <td class="max-w-[200px] truncate px-3 py-1.5 font-mono text-gray-500 dark:text-gray-400" title={req.path}>
                              {req.path}
                            </td>
                            <td class="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-gray-500 dark:text-gray-400">
                              {formatDuration(req.durationMs)}
                            </td>
                            <td class="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-gray-500 dark:text-gray-400">
                              {req.tokensIn != null ? req.tokensIn.toLocaleString() : "-"}
                            </td>
                            <td class="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-gray-500 dark:text-gray-400">
                              {req.tokensOut != null ? req.tokensOut.toLocaleString() : "-"}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </Show>
            </div>
          </Show>

          {/* Server Logs Tab */}
          <Show when={activeTab() === "server"}>
            {/* Filters */}
            <div class="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-800 sm:px-6">
              {/* Level filter tabs */}
              <div class="flex items-center gap-1">
                <For
                  each={[
                    { id: "all", label: t("logs.levels.all") },
                    { id: "ERROR", label: t("logs.levels.error") },
                    { id: "WARN", label: t("logs.levels.warn") },
                    { id: "INFO", label: t("logs.levels.info") },
                    { id: "DEBUG", label: t("logs.levels.debug") },
                  ]}
                >
                  {(level) => (
                    <button
                      class={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                        filter() === level.id
                          ? level.id === "all"
                            ? "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
                            : levelColors[level.id] || "bg-gray-200 dark:bg-gray-700"
                          : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                      }`}
                      onClick={() => setFilter(level.id)}
                    >
                      {level.label}
                      <Show when={logCounts()[level.id] > 0}>
                        <span class="ml-1 opacity-60">({logCounts()[level.id]})</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>

              {/* Search */}
              <div class="max-w-xs flex-1">
                <input
                  class="transition-smooth w-full rounded-lg border border-gray-200 bg-gray-100 px-3 py-1.5 text-sm focus:border-transparent focus:ring-2 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800"
                  onInput={(e) => setSearch(e.currentTarget.value)}
                  placeholder={t("logs.searchPlaceholder")}
                  type="text"
                  value={search()}
                />
              </div>
            </div>

            {/* Log list */}
            <div
              class="flex-1 overflow-y-auto bg-gray-50 font-mono text-xs dark:bg-gray-900"
              ref={logContainerRef}
            >
              {/* Loading skeleton for initial load */}
              <Show when={initialLoad() && loading()}>
                <div class="space-y-1 p-2">
                  <For each={Array(12).fill(0)}>
                    {() => (
                      <div class="flex animate-pulse items-center gap-2 px-2 py-1">
                        <div class="h-4 w-36 rounded bg-gray-200 dark:bg-gray-700" />
                        <div class="h-4 w-12 rounded bg-gray-200 dark:bg-gray-700" />
                        <div class="h-4 flex-1 rounded bg-gray-200 dark:bg-gray-700" />
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={!initialLoad() || !loading()}>
                <Show
                  fallback={
                    <div class="flex h-full items-center justify-center">
                      <EmptyState
                        description={
                          search() || filter() !== "all"
                            ? t("logs.noLogsMatchFilters")
                            : t("logs.logsWillAppear")
                        }
                        icon={
                          <svg
                            class="h-10 w-10"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              stroke-width="1.5"
                            />
                          </svg>
                        }
                        title={t("logs.noLogs")}
                      />
                    </div>
                  }
                  when={filteredLogs().length > 0}
                >
                  <div class="space-y-0.5 p-2">
                    {/* Load more button at top */}
                    <Show when={hasMoreLogs()}>
                      <div class="py-2 text-center">
                        <button
                          class="text-xs font-medium text-brand-500 hover:text-brand-600 dark:text-brand-400 dark:hover:text-brand-300"
                          onClick={loadMoreLogs}
                        >
                          {t("logs.loadOlderPrefix")}{" "}
                          {Math.min(DISPLAY_CHUNK_SIZE, filteredLogs().length - displayLimit())}{" "}
                          {t("logs.loadOlderMiddle")} ({filteredLogs().length - displayLimit()}{" "}
                          {t("logs.remaining")})
                        </button>
                      </div>
                    </Show>
                    <For each={displayedLogs()}>
                      {(log) => (
                        <div class="group flex items-start gap-2 rounded px-2 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800">
                          {/* Timestamp */}
                          <Show when={log.timestamp}>
                            <span class="w-40 shrink-0 text-[11px] tabular-nums text-gray-400 dark:text-gray-500">
                              {log.timestamp}
                            </span>
                          </Show>

                          {/* Level badge */}
                          <span
                            class={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                              levelColors[log.level.toUpperCase()] || "bg-gray-500/10 text-gray-500"
                            }`}
                          >
                            {log.level.slice(0, 5)}
                          </span>

                          {/* Message */}
                          <span class="min-w-0 flex-1 whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">
                            {log.message}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>
          </Show>

          {/* Error Logs Tab */}
          <Show when={activeTab() === "errors"}>
            <div class="flex flex-1 overflow-hidden">
              {/* Error log file list */}
              <div class="w-48 overflow-y-auto border-r border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900">
                <div class="space-y-1 p-2">
                  <Show
                    fallback={
                      <div class="p-2 text-center text-xs text-gray-400 dark:text-gray-500">
                        {loadingErrorLogs()
                          ? t("common.loading") + "..."
                          : t("logs.noErrorLogsFound")}
                      </div>
                    }
                    when={errorLogFiles().length > 0}
                  >
                    <For each={errorLogFiles()}>
                      {(file) => (
                        <button
                          class={`w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs transition-colors ${
                            selectedErrorLog() === file
                              ? "bg-brand-500/20 text-brand-600 dark:text-brand-400"
                              : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                          }`}
                          onClick={() => handleSelectErrorLog(file)}
                          title={file}
                        >
                          {file}
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              </div>

              {/* Error log content */}
              <div class="flex-1 overflow-y-auto bg-gray-50 font-mono text-xs dark:bg-gray-900">
                <Show
                  fallback={
                    <div class="flex h-full items-center justify-center">
                      <EmptyState
                        description={
                          loadingErrorLogs()
                            ? t("logs.loadingErrorLogContent")
                            : t("logs.selectLogFromLeft")
                        }
                        icon={
                          <svg
                            class="h-10 w-10"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              stroke-width="1.5"
                            />
                          </svg>
                        }
                        title={
                          loadingErrorLogs()
                            ? t("common.loading") + "..."
                            : t("logs.selectAnErrorLog")
                        }
                      />
                    </div>
                  }
                  when={errorLogContent()}
                >
                  <pre class="whitespace-pre-wrap break-words p-4 text-gray-700 dark:text-gray-300">
                    {errorLogContent()}
                  </pre>
                </Show>
              </div>
            </div>
          </Show>
        </Show>
      </main>

      {/* Clear Confirmation Modal */}
      <Show when={showClearConfirm()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div class="mx-4 w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-800">
            <h3 class="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t("logs.modals.clearAllLogsTitle")}
            </h3>
            <p class="mb-6 text-gray-600 dark:text-gray-400">
              {t("logs.modals.clearAllLogsDescription", {
                count: logs().length,
              })}
            </p>
            <div class="flex justify-end gap-3">
              <Button onClick={() => setShowClearConfirm(false)} variant="ghost">
                {t("common.cancel")}
              </Button>
              <Button class="bg-red-500 hover:bg-red-600" onClick={handleClear} variant="primary">
                {t("logs.actions.clearLogs")}
              </Button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
