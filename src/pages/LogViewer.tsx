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
import { onRequestLog, type RequestLog, getProxyRequestLogs } from "../lib/tauri/logs";
import { appStore } from "../stores/app";
import { toastStore } from "../stores/toast";

const levelColors: Record<string, string> = {
  DEBUG: "text-gray-500 bg-gray-500/10",
  ERROR: "text-red-500 bg-red-500/10",
  INFO: "text-blue-500 bg-blue-500/10",
  TRACE: "text-gray-400 bg-gray-400/10",
  WARN: "text-yellow-500 bg-yellow-500/10",
};

const PAGE_SIZE_OPTIONS = [50, 100, 200, 500];
const INITIAL_LOG_FETCH = 500;

type LogTab = "requests" | "server" | "errors";
type StatusFilter = "all" | "success" | "error";
type QuickFilter = "" | "completions" | "embeddings" | "images" | "__ERROR__";

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) {
    return "text-green-500 bg-green-500/10";
  }
  if (status >= 400 && status < 500) {
    return "text-yellow-500 bg-yellow-500/10";
  }
  if (status >= 500) {
    return "text-red-500 bg-red-500/10";
  }
  return "text-gray-500 bg-gray-500/10";
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1) + "M";
  }
  if (n >= 1000) {
    return (n / 1000).toFixed(1) + "K";
  }
  return String(n);
}

export function LogViewerPage() {
  const { t } = useI18n();
  const { proxyStatus } = appStore;
  const [activeTab, setActiveTab] = createSignal<LogTab>("requests");
  const [logs, setLogs] = createSignal<LogEntry[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [initialLoad, setInitialLoad] = createSignal(true);
  const [autoRefresh, setAutoRefresh] = createSignal(false);
  const [filter, setFilter] = createSignal<string>("all");
  const [search, setSearch] = createSignal("");
  const [showClearConfirm, setShowClearConfirm] = createSignal(false);
  const [displayLimit, setDisplayLimit] = createSignal(100);

  const [requestLogs, setRequestLogs] = createSignal<RequestLog[]>([]);
  const [requestSearch, setRequestSearch] = createSignal("");
  const [statusFilter, setStatusFilter] = createSignal<StatusFilter>("all");
  const [quickFilter, setQuickFilter] = createSignal<QuickFilter>("");
  const [requestLoading, setRequestLoading] = createSignal(true);
  const [selectedLog, setSelectedLog] = createSignal<RequestLog | null>(null);

  // Pagination
  const [pageSize, setPageSize] = createSignal(100);
  const [currentPage, setCurrentPage] = createSignal(1);

  let unlistenRequestLog: (() => void) | null = null;

  const [errorLogFiles, setErrorLogFiles] = createSignal<string[]>([]);
  const [selectedErrorLog, setSelectedErrorLog] = createSignal<string>("");
  const [errorLogContent, setErrorLogContent] = createSignal<string>("");
  const [loadingErrorLogs, setLoadingErrorLogs] = createSignal(false);

  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  let logContainerRef: HTMLDivElement | undefined;
  let prevRunning = false;

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

  createEffect(() => {
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
      const serverLogs = await getProxyRequestLogs(2000);
      setRequestLogs(serverLogs);
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
          if (prev.some((r) => r.id === log.id)) {
            return prev;
          }
          return [log, ...prev].slice(0, 2000);
        });
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

  // Stats computed from all request logs
  const stats = createMemo(() => {
    const all = requestLogs();
    const total = all.length;
    const success = all.filter((r) => r.status >= 200 && r.status < 400).length;
    const errors = all.filter((r) => r.status >= 400).length;
    return { errors, success, total };
  });

  const filteredRequestLogs = createMemo(() => {
    let result = requestLogs();

    // Quick filter
    const qf = quickFilter();
    if (qf === "__ERROR__") {
      result = result.filter((r) => r.status >= 400);
    } else if (qf) {
      result = result.filter((r) => r.path.toLowerCase().includes(qf));
    }

    // Status filter
    const sf = statusFilter();
    if (sf === "success") {
      result = result.filter((r) => r.status >= 200 && r.status < 400);
    } else if (sf === "error") {
      result = result.filter((r) => r.status >= 400);
    }

    // Search
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

    // Sort newest first
    return [...result].sort((a, b) => b.timestamp - a.timestamp);
  });

  // Pagination
  const totalFiltered = createMemo(() => filteredRequestLogs().length);
  const totalPages = createMemo(() => Math.max(1, Math.ceil(totalFiltered() / pageSize())));
  const paginatedLogs = createMemo(() => {
    const start = (currentPage() - 1) * pageSize();
    return filteredRequestLogs().slice(start, start + pageSize());
  });

  // Reset page when filters change
  createEffect(() => {
    requestSearch();
    statusFilter();
    quickFilter();
    setCurrentPage(1);
  });

  const goToPage = (page: number) => {
    const max = totalPages();
    if (page >= 1 && page <= max) {
      setCurrentPage(page);
    }
  };

  const loadLogs = async () => {
    const isFirstLoad = initialLoad();
    if (!isFirstLoad && loading()) {
      return;
    }
    setLoading(true);
    try {
      const result = await getLogs(INITIAL_LOG_FETCH);
      setLogs(result);
      setDisplayLimit(100);
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

  const filteredLogs = createMemo(() => {
    let result = logs();
    if (filter() !== "all") {
      result = result.filter((log) => log.level.toUpperCase() === filter().toUpperCase());
    }
    const searchTerm = search().toLowerCase();
    if (searchTerm) {
      result = result.filter((log) => log.message.toLowerCase().includes(searchTerm));
    }
    return result;
  });

  const displayedLogs = createMemo(() => {
    const all = filteredLogs();
    const limit = displayLimit();
    if (all.length <= limit) {
      return all;
    }
    return all.slice(-limit);
  });

  const hasMoreLogs = createMemo(() => filteredLogs().length > displayLimit());
  const loadMoreLogs = () => {
    setDisplayLimit((prev) => prev + 100);
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

  const loadErrorLogFiles = async () => {
    if (!proxyStatus().running) {
      return;
    }
    if (errorLogFiles().length > 0) {
      return;
    }
    setLoadingErrorLogs(true);
    try {
      const files = await getRequestErrorLogs();
      setErrorLogFiles(files);
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

  createEffect(() => {
    if (activeTab() === "errors" && proxyStatus().running) {
      loadErrorLogFiles();
    }
  });

  const handleDownload = () => {
    const content = logs()
      .map((log) => `${log.timestamp ? log.timestamp + " " : ""}[${log.level}] ${log.message}`)
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

  const quickFilters: { label: string; value: QuickFilter }[] = [
    { label: "All", value: "" },
    { label: "Errors", value: "__ERROR__" },
    { label: "Chat", value: "completions" },
    { label: "Embeddings", value: "embeddings" },
    { label: "Images", value: "images" },
  ];

  return (
    <div class="flex min-h-screen flex-col bg-white dark:bg-gray-900">
      <header class="sticky top-0 z-10 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900 sm:px-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 sm:gap-3">
            <h1 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t("logs.title")}
            </h1>
            <div class="ml-2 flex items-center gap-1 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
              <For each={["requests", "server", "errors"] as LogTab[]}>
                {(tab) => (
                  <button
                    class={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      activeTab() === tab
                        ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100"
                        : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                    }`}
                    onClick={() => setActiveTab(tab)}
                  >
                    {t(`logs.tabs.${tab}`)}
                  </button>
                )}
              </For>
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
            <Show when={activeTab() !== "requests"}>
              <button
                class={`rounded-lg p-2 transition-colors ${autoRefresh() ? "bg-brand-500/20 text-brand-500" : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"}`}
                onClick={() => setAutoRefresh(!autoRefresh())}
              >
                <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                  <Show fallback={<path d="M8 5v14l11-7z" />} when={autoRefresh()}>
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </Show>
                </svg>
              </button>
              <button
                class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"
                disabled={loading()}
                onClick={loadLogs}
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
              <Show when={logs().length > 0}>
                <button
                  class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                  onClick={handleDownload}
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
                <Button
                  class="text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
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

      <main class="flex flex-1 flex-col overflow-hidden">
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
          <Show when={activeTab() === "requests"}>
            {/* Toolbar */}
            <div class="space-y-2 border-b border-gray-200 bg-gray-50/30 px-4 py-3 dark:border-gray-800 dark:bg-gray-800/30 sm:px-6">
              <div class="flex flex-wrap items-center gap-3">
                {/* Search */}
                <div class="relative max-w-xs flex-1">
                  <svg
                    class="absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                    />
                  </svg>
                  <input
                    class="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-3 text-sm focus:border-transparent focus:ring-2 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800"
                    onInput={(e) => setRequestSearch(e.currentTarget.value)}
                    placeholder="Search model, path, account..."
                    type="text"
                    value={requestSearch()}
                  />
                </div>

                {/* Stats */}
                <div class="hidden items-center gap-4 text-[10px] font-bold uppercase lg:flex">
                  <span class="text-blue-500">{formatCompact(stats().total)} total</span>
                  <span class="text-green-500">{formatCompact(stats().success)} ok</span>
                  <span class="text-red-500">{formatCompact(stats().errors)} err</span>
                </div>

                {/* Refresh */}
                <button
                  class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                  onClick={loadRequestHistory}
                >
                  <svg
                    class={`h-4 w-4 ${requestLoading() ? "animate-spin" : ""}`}
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
                <Show when={requestLogs().length > 0}>
                  <button
                    class="rounded-lg px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                    onClick={() => setRequestLogs([])}
                  >
                    {t("logs.actions.clear")}
                  </button>
                </Show>
              </div>

              {/* Quick filters */}
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  Filters
                </span>
                <For each={quickFilters}>
                  {(q) => (
                    <button
                      class={`rounded-full border px-2.5 py-0.5 text-[10px] transition-colors ${quickFilter() === q.value ? "border-blue-500 bg-blue-500 text-white" : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"}`}
                      onClick={() => setQuickFilter(q.value)}
                    >
                      {q.label}
                    </button>
                  )}
                </For>
                <Show when={quickFilter() || requestSearch()}>
                  <button
                    class="text-[10px] text-blue-500"
                    onClick={() => {
                      setQuickFilter("");
                      setRequestSearch("");
                      setStatusFilter("all");
                    }}
                  >
                    Reset
                  </button>
                </Show>
              </div>
            </div>

            {/* Table */}
            <div class="flex-1 overflow-x-auto overflow-y-auto">
              <Show when={requestLoading()}>
                <div class="space-y-1 p-4">
                  <For each={Array(8).fill(0)}>
                    {() => (
                      <div class="flex animate-pulse items-center gap-3 rounded px-2 py-2">
                        <div class="h-4 w-16 rounded bg-gray-200 dark:bg-gray-700" />
                        <div class="h-4 w-20 rounded bg-gray-200 dark:bg-gray-700" />
                        <div class="h-4 w-32 rounded bg-gray-200 dark:bg-gray-700" />
                        <div class="h-4 flex-1 rounded bg-gray-200 dark:bg-gray-700" />
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={!requestLoading()}>
                <Show
                  fallback={
                    <div class="flex h-64 items-center justify-center">
                      <EmptyState
                        description={
                          requestSearch() || quickFilter()
                            ? t("logs.requests.noResults")
                            : t("logs.requests.emptyDescription")
                        }
                        icon={
                          <svg
                            class="h-10 w-10"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              d="M13 10V3L4 14h7v7l9-11h-7z"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              stroke-width="1.5"
                            />
                          </svg>
                        }
                        title={t("logs.requests.empty")}
                      />
                    </div>
                  }
                  when={paginatedLogs().length > 0}
                >
                  <table class="w-full text-xs">
                    <thead class="sticky top-0 z-10 bg-gray-50 dark:bg-gray-800/90">
                      <tr class="text-left text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                        <th class="px-3 py-2">{t("logs.requests.status")}</th>
                        <th class="px-3 py-2">{t("logs.requests.method")}</th>
                        <th class="px-3 py-2">{t("logs.requests.model")}</th>
                        <th class="px-3 py-2">{t("logs.requests.account")}</th>
                        <th class="px-3 py-2">{t("logs.requests.path")}</th>
                        <th class="px-3 py-2 text-right">Usage</th>
                        <th class="px-3 py-2 text-right">{t("logs.requests.duration")}</th>
                        <th class="px-3 py-2 text-right">{t("logs.requests.time")}</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                      <For each={paginatedLogs()}>
                        {(req) => (
                          <tr
                            class="cursor-pointer transition-colors hover:bg-blue-50 dark:hover:bg-blue-900/20"
                            onClick={() => setSelectedLog(req)}
                          >
                            <td class="px-3 py-1.5">
                              <span
                                class={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${statusColor(req.status)}`}
                              >
                                {req.status}
                              </span>
                            </td>
                            <td class="px-3 py-1.5 font-mono text-gray-700 dark:text-gray-300">
                              {req.method}
                            </td>
                            <td
                              class="max-w-[200px] truncate px-3 py-1.5 font-mono text-blue-600 dark:text-blue-400"
                              title={req.model}
                            >
                              {req.model && req.model !== "unknown" ? req.model : "-"}
                            </td>
                            <td
                              class="max-w-[160px] truncate px-3 py-1.5 text-gray-600 dark:text-gray-400"
                              title={req.account || ""}
                            >
                              {req.account ? (
                                <span class="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                                  {req.account}
                                </span>
                              ) : (
                                <span class="text-gray-300 dark:text-gray-600">-</span>
                              )}
                            </td>
                            <td
                              class="max-w-[180px] truncate px-3 py-1.5 font-mono text-gray-500 dark:text-gray-400"
                              title={req.path}
                            >
                              {req.path}
                            </td>
                            <td class="px-3 py-1.5 text-right text-[9px]">
                              <Show when={req.tokensIn != null}>
                                <div>I: {formatCompact(req.tokensIn!)}</div>
                              </Show>
                              <Show when={req.tokensOut != null}>
                                <div>O: {formatCompact(req.tokensOut!)}</div>
                              </Show>
                            </td>
                            <td class="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-gray-500 dark:text-gray-400">
                              {formatDuration(req.durationMs)}
                            </td>
                            <td class="whitespace-nowrap px-3 py-1.5 text-right text-[10px] tabular-nums text-gray-400">
                              {new Date(req.timestamp).toLocaleTimeString()}
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </Show>
            </div>

            {/* Pagination */}
            <div class="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-4 py-2.5 text-xs dark:border-gray-800 dark:bg-gray-800/50">
              <div class="flex items-center gap-2">
                <span class="text-gray-500">Per page</span>
                <select
                  class="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs dark:border-gray-700 dark:bg-gray-800"
                  onChange={(e) => {
                    setPageSize(Number(e.currentTarget.value));
                    setCurrentPage(1);
                  }}
                  value={pageSize()}
                >
                  <For each={PAGE_SIZE_OPTIONS}>
                    {(size) => <option value={size}>{size}</option>}
                  </For>
                </select>
              </div>
              <div class="flex items-center gap-2">
                <button
                  class="rounded p-1 text-gray-400 hover:bg-gray-200 disabled:opacity-30 dark:hover:bg-gray-700"
                  disabled={currentPage() <= 1}
                  onClick={() => goToPage(currentPage() - 1)}
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      d="M15 19l-7-7 7-7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                    />
                  </svg>
                </button>
                <span class="min-w-[60px] text-center text-gray-600 dark:text-gray-400">
                  {currentPage()} / {totalPages()}
                </span>
                <button
                  class="rounded p-1 text-gray-400 hover:bg-gray-200 disabled:opacity-30 dark:hover:bg-gray-700"
                  disabled={currentPage() >= totalPages()}
                  onClick={() => goToPage(currentPage() + 1)}
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      d="M9 5l7 7-7 7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                    />
                  </svg>
                </button>
              </div>
              <div class="text-gray-500">
                {totalFiltered() === 0
                  ? "0"
                  : `${(currentPage() - 1) * pageSize() + 1}-${Math.min(currentPage() * pageSize(), totalFiltered())}`}{" "}
                of {totalFiltered()}
              </div>
            </div>
          </Show>

          <Show when={activeTab() === "server"}>
            <div class="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-800 sm:px-6">
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
                      class={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${filter() === level.id ? (level.id === "all" ? "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100" : levelColors[level.id] || "bg-gray-200 dark:bg-gray-700") : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"}`}
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
              <div class="max-w-xs flex-1">
                <input
                  class="w-full rounded-lg border border-gray-200 bg-gray-100 px-3 py-1.5 text-sm focus:border-transparent focus:ring-2 focus:ring-brand-500 dark:border-gray-700 dark:bg-gray-800"
                  onInput={(e) => setSearch(e.currentTarget.value)}
                  placeholder={t("logs.searchPlaceholder")}
                  type="text"
                  value={search()}
                />
              </div>
            </div>
            <div
              class="flex-1 overflow-y-auto bg-gray-50 font-mono text-xs dark:bg-gray-900"
              ref={logContainerRef}
            >
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
                    <Show when={hasMoreLogs()}>
                      <div class="py-2 text-center">
                        <button
                          class="text-xs font-medium text-brand-500 hover:text-brand-600"
                          onClick={loadMoreLogs}
                        >
                          Load more ({filteredLogs().length - displayLimit()} remaining)
                        </button>
                      </div>
                    </Show>
                    <For each={displayedLogs()}>
                      {(log) => (
                        <div class="group flex items-start gap-2 rounded px-2 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800">
                          <Show when={log.timestamp}>
                            <span class="w-40 shrink-0 text-[11px] tabular-nums text-gray-400 dark:text-gray-500">
                              {log.timestamp}
                            </span>
                          </Show>
                          <span
                            class={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${levelColors[log.level.toUpperCase()] || "bg-gray-500/10 text-gray-500"}`}
                          >
                            {log.level.slice(0, 5)}
                          </span>
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

          <Show when={activeTab() === "errors"}>
            <div class="flex flex-1 overflow-hidden">
              <div class="w-48 overflow-y-auto border-r border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-900">
                <div class="space-y-1 p-2">
                  <Show
                    fallback={
                      <div class="p-2 text-center text-xs text-gray-400">
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
                          class={`w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs transition-colors ${selectedErrorLog() === file ? "bg-brand-500/20 text-brand-600 dark:text-brand-400" : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"}`}
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

      <Show when={showClearConfirm()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div class="mx-4 w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-800">
            <h3 class="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t("logs.modals.clearAllLogsTitle")}
            </h3>
            <p class="mb-6 text-gray-600 dark:text-gray-400">
              {t("logs.modals.clearAllLogsDescription", { count: logs().length })}
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

      {/* Request Detail Modal */}
      <Show when={selectedLog()}>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setSelectedLog(null)}
        >
          <div
            class="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div class="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
              <div class="flex items-center gap-3">
                <span
                  class={`inline-block rounded px-1.5 py-0.5 text-xs font-bold ${statusColor(selectedLog()!.status)}`}
                >
                  {selectedLog()!.status}
                </span>
                <span class="font-mono text-sm font-bold text-gray-900 dark:text-gray-100">
                  {selectedLog()!.method}
                </span>
                <span class="hidden max-w-md truncate font-mono text-xs text-gray-500 dark:text-gray-400 sm:inline">
                  {selectedLog()!.path}
                </span>
              </div>
              <button
                class="rounded-full p-1.5 text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
                onClick={() => setSelectedLog(null)}
              >
                <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    d="M6 18L18 6M6 6l12 12"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                  />
                </svg>
              </button>
            </div>
            {/* Modal Content */}
            <div class="flex-1 space-y-5 overflow-y-auto p-4">
              <div class="rounded-xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-700 dark:bg-gray-900">
                <div class="grid grid-cols-1 gap-x-10 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <span class="block text-[10px] font-black uppercase tracking-widest text-gray-500">
                      Time
                    </span>
                    <span class="font-mono text-xs font-semibold text-gray-900 dark:text-gray-100">
                      {new Date(selectedLog()!.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span class="block text-[10px] font-black uppercase tracking-widest text-gray-500">
                      Duration
                    </span>
                    <span class="font-mono text-xs font-semibold text-gray-900 dark:text-gray-100">
                      {formatDuration(selectedLog()!.durationMs)}
                    </span>
                  </div>
                  <div>
                    <span class="block text-[10px] font-black uppercase tracking-widest text-gray-500">
                      Tokens
                    </span>
                    <div class="flex gap-2 font-mono text-[11px]">
                      <span class="rounded-md border border-blue-200 bg-blue-100 px-2.5 py-1 font-bold text-blue-700 dark:border-blue-800/50 dark:bg-blue-900/40 dark:text-blue-300">
                        In: {formatCompact(selectedLog()!.tokensIn ?? 0)}
                      </span>
                      <span class="rounded-md border border-green-200 bg-green-100 px-2.5 py-1 font-bold text-green-700 dark:border-green-800/50 dark:bg-green-900/40 dark:text-green-300">
                        Out: {formatCompact(selectedLog()!.tokensOut ?? 0)}
                      </span>
                    </div>
                  </div>
                </div>
                <div class="mt-4 grid grid-cols-1 gap-4 border-t border-gray-200 pt-4 dark:border-gray-700 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <span class="block text-[10px] font-black uppercase tracking-widest text-gray-500">
                      Model
                    </span>
                    <span class="font-mono text-sm font-black text-blue-600 dark:text-blue-400">
                      {selectedLog()!.model || "-"}
                    </span>
                  </div>
                  <div>
                    <span class="block text-[10px] font-black uppercase tracking-widest text-gray-500">
                      Provider
                    </span>
                    <span class="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {selectedLog()!.provider || "-"}
                    </span>
                  </div>
                  <Show when={selectedLog()!.account}>
                    <div>
                      <span class="block text-[10px] font-black uppercase tracking-widest text-gray-500">
                        Account
                      </span>
                      <span class="font-mono text-xs font-semibold text-gray-900 dark:text-gray-100">
                        {selectedLog()!.account}
                      </span>
                    </div>
                  </Show>
                </div>
              </div>
              <div>
                <h3 class="mb-2 text-xs font-bold uppercase text-gray-400">Full Path</h3>
                <div class="rounded-lg border border-gray-100 bg-gray-50 p-3 font-mono text-[10px] text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
                  {selectedLog()!.path}
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
