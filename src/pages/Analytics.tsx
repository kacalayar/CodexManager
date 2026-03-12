import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { EChartsWrapper } from "../components/charts";
import { useI18n } from "../i18n";
import {
  exportUsageStats,
  getUsageStats,
  importUsageStats,
  onRequestLog,
  type UsageStats,
} from "../lib/tauri";
import { toastStore } from "../stores/toast";

import type { EChartsOption } from "echarts";

type TimeRange = "hourly" | "daily" | "weekly";

function formatNumber(num: number): string {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1) + "M";
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K";
  }
  return num.toLocaleString();
}

function formatLabel(label: string, range: TimeRange): string {
  if (range === "hourly") {
    const parts = label.split("T");
    return parts.length === 2 ? `${parts[1]}:00` : label;
  }
  try {
    const parts = label.split("-");
    if (parts.length === 3) {
      return `${parts[1]}/${parts[2]}`;
    }
    return label;
  } catch {
    return label;
  }
}

const MODEL_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#6366f1",
  "#f43f5e",
  "#84cc16",
  "#a855f7",
  "#14b8a6",
  "#f97316",
  "#64748b",
  "#0ea5e9",
  "#d946ef",
];

export function Analytics() {
  const { t } = useI18n();
  const [stats, setStats] = createSignal<UsageStats | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [timeRange, setTimeRange] = createSignal<TimeRange>("daily");
  const [refreshing, setRefreshing] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  const [importing, setImporting] = createSignal(false);

  const fetchStats = async (showToast = false) => {
    try {
      setRefreshing(true);
      const data = await getUsageStats();
      setStats(data);
    } catch (error) {
      if (showToast) {
        toastStore.error("Failed to load analytics", String(error));
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleExport = async () => {
    try {
      setExporting(true);
      const data = await exportUsageStats();
      const filePath = await save({
        defaultPath: `proxypal-usage-${new Date().toISOString().split("T")[0]}.json`,
        filters: [{ extensions: ["json"], name: "JSON" }],
      });
      if (filePath) {
        await writeTextFile(filePath, JSON.stringify(data, null, 2));
      }
    } catch (error) {
      toastStore.error("Failed to export usage stats", String(error));
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    try {
      setImporting(true);
      const filePath = await open({
        filters: [{ extensions: ["json"], name: "JSON" }],
        multiple: false,
      });
      if (filePath) {
        const content = await readTextFile(filePath as string);
        const data = JSON.parse(content);
        await importUsageStats(data);
        await fetchStats();
      }
    } catch (error) {
      toastStore.error("Failed to import usage stats", String(error));
    } finally {
      setImporting(false);
    }
  };

  onMount(() => {
    fetchStats();
  });

  let unlistenRef: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(async () => {
    try {
      const unlisten = await onRequestLog(() => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
          fetchStats();
        }, 1500);
      });
      unlistenRef = unlisten;
    } catch (error) {
      void error;
    }
  });

  onCleanup(() => {
    if (unlistenRef) {
      unlistenRef();
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
  });

  // Get data based on time range
  const getFilteredData = (
    hourly: { label: string; value: number }[],
    daily: { label: string; value: number }[],
  ) => {
    const range = timeRange();
    if (range === "hourly") {
      return hourly.slice(-24);
    }
    if (range === "daily") {
      return daily.slice(-7);
    }
    return daily.slice(-30);
  };

  const requestsData = createMemo(() => {
    const s = stats();
    if (!s) {
      return [];
    }
    return getFilteredData(s.requestsByHour, s.requestsByDay);
  });

  const tokensData = createMemo(() => {
    const s = stats();
    if (!s) {
      return [];
    }
    return getFilteredData(s.tokensByHour, s.tokensByDay);
  });

  const successRate = createMemo(() => {
    const s = stats();
    if (!s || s.totalRequests === 0) {
      return 100;
    }
    return Math.round((s.successCount / s.totalRequests) * 100);
  });

  const estimatedCost = createMemo(() => {
    const s = stats();
    if (!s) {
      return 0;
    }
    return (s.inputTokens / 1_000_000) * 3 + (s.outputTokens / 1_000_000) * 15;
  });

  const knownModels = createMemo(() => {
    const s = stats();
    if (!s) {
      return [];
    }
    return s.models
      .filter((m) => m.model !== "unknown" && m.model !== "")
      .sort((a, b) => b.requests - a.requests);
  });

  // ECharts: Token usage bar chart (input vs output)
  const tokenBarOption = createMemo((): EChartsOption => {
    const data = tokensData();
    const range = timeRange();
    return {
      grid: { bottom: 30, left: 50, right: 20, top: 20 },
      series: [
        {
          data: data.map((d) => d.value),
          itemStyle: { borderRadius: [4, 4, 0, 0], color: "#3b82f6" },
          name: "Tokens",
          type: "bar",
        },
      ],
      tooltip: { trigger: "axis" },
      xAxis: {
        axisLine: { show: false },
        axisTick: { show: false },
        data: data.map((d) => formatLabel(d.label, range)),
        type: "category",
      },
      yAxis: {
        axisLabel: { formatter: (v: number) => formatNumber(v) },
        splitLine: { lineStyle: { opacity: 0.3, type: "dashed" } },
        type: "value",
      },
    };
  });

  // ECharts: Requests area chart
  const requestAreaOption = createMemo((): EChartsOption => {
    const data = requestsData();
    const range = timeRange();
    return {
      grid: { bottom: 30, left: 50, right: 20, top: 20 },
      series: [
        {
          areaStyle: { opacity: 0.15 },
          data: data.map((d) => d.value),
          itemStyle: { color: "#8b5cf6" },
          lineStyle: { width: 2 },
          name: "Requests",
          smooth: true,
          type: "line",
        },
      ],
      tooltip: { trigger: "axis" },
      xAxis: {
        axisLine: { show: false },
        axisTick: { show: false },
        data: data.map((d) => formatLabel(d.label, range)),
        type: "category",
      },
      yAxis: { splitLine: { lineStyle: { opacity: 0.3, type: "dashed" } }, type: "value" },
    };
  });

  // ECharts: Model pie chart
  const modelPieOption = createMemo((): EChartsOption => {
    const models = knownModels().slice(0, 10);
    return {
      series: [
        {
          center: ["50%", "50%"],
          data: models.map((m, i) => ({
            itemStyle: { color: MODEL_COLORS[i % MODEL_COLORS.length] },
            name: m.model,
            value: m.requests,
          })),
          label: { fontSize: 10, formatter: "{b}\n{d}%", show: true },
          radius: ["40%", "70%"],
          type: "pie",
        },
      ],
      tooltip: { formatter: "{b}: {c} ({d}%)", trigger: "item" },
    };
  });

  const formatCost = (cost: number) => {
    if (cost < 0.01) {
      return t("analytics.lessThanCent");
    }
    return `$${cost.toFixed(2)}`;
  };

  return (
    <div class="h-full overflow-y-auto bg-white dark:bg-gray-900">
      <div class="mx-auto max-w-7xl space-y-4 p-4 sm:p-5">
        {/* Header */}
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 class="flex items-center gap-2 text-2xl font-bold text-gray-800 dark:text-white">
              <svg
                class="h-6 w-6 text-blue-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                />
              </svg>
              {t("analytics.title")}
            </h1>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            {/* Time Range Selector */}
            <div class="flex rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
              <For
                each={[
                  {
                    icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
                    label: t("analytics.presets.24h"),
                    value: "hourly" as TimeRange,
                  },
                  {
                    icon: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
                    label: t("analytics.presets.7d"),
                    value: "daily" as TimeRange,
                  },
                  {
                    icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
                    label: t("analytics.presets.30d"),
                    value: "weekly" as TimeRange,
                  },
                ]}
              >
                {(item) => (
                  <button
                    class={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${timeRange() === item.value ? "bg-white text-blue-600 shadow-sm dark:bg-gray-700" : "text-gray-600 hover:text-gray-800 dark:text-gray-400"}`}
                    onClick={() => setTimeRange(item.value)}
                  >
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        d={item.icon}
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                      />
                    </svg>
                    {item.label}
                  </button>
                )}
              </For>
            </div>

            <button
              class="flex items-center gap-2 rounded-lg bg-blue-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
              disabled={refreshing()}
              onClick={() => fetchStats(true)}
            >
              <svg
                class={`h-4 w-4 ${refreshing() ? "animate-spin" : ""}`}
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
            <button
              class="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
              disabled={exporting()}
              onClick={handleExport}
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                />
              </svg>
              <span class="hidden sm:inline">{t("analytics.export")}</span>
            </button>
            <button
              class="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
              disabled={importing()}
              onClick={handleImport}
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                />
              </svg>
              <span class="hidden sm:inline">{t("analytics.import")}</span>
            </button>
          </div>
        </div>

        {/* Loading */}
        <Show when={loading()}>
          <div class="grid grid-cols-2 gap-4 md:grid-cols-5">
            <For each={[1, 2, 3, 4, 5]}>
              {() => <div class="h-24 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />}
            </For>
          </div>
        </Show>

        {/* Empty state */}
        <Show when={!loading() && (!stats() || stats()!.totalRequests === 0)}>
          <div class="rounded-xl border border-gray-200 bg-white py-16 text-center shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <svg
              class="mx-auto mb-4 h-16 w-16 text-gray-300 dark:text-gray-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
              />
            </svg>
            <h3 class="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t("analytics.noUsageDataYet")}
            </h3>
            <p class="text-gray-500 dark:text-gray-400">{t("analytics.noUsageDescription")}</p>
          </div>
        </Show>

        <Show when={!loading() && stats() && stats()!.totalRequests > 0}>
          {/* Summary Cards - 5 columns like Antigravity-Manager */}
          <div class="grid grid-cols-2 gap-4 md:grid-cols-5">
            <div class="rounded-xl border border-gray-200 bg-gradient-to-br from-white to-gray-50 p-4 shadow-sm hover:shadow-md dark:border-gray-700 dark:from-gray-800 dark:to-gray-800/50">
              <div class="mb-2 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <div class="rounded-lg bg-gray-100 p-1.5 dark:bg-gray-700">
                  <svg
                    class="h-4 w-4 text-gray-600 dark:text-gray-300"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                    />
                  </svg>
                </div>
                {t("dashboard.kpi.totalRequests")}
              </div>
              <div class="text-2xl font-bold text-gray-800 dark:text-white">
                {formatNumber(stats()!.totalRequests)}
              </div>
            </div>
            <div class="rounded-xl border border-blue-100 bg-gradient-to-br from-blue-50/50 to-white p-4 shadow-sm hover:shadow-md dark:border-blue-900/30 dark:from-blue-900/10 dark:to-gray-800">
              <div class="mb-2 flex items-center gap-2 text-sm text-blue-600/80 dark:text-blue-400/80">
                <div class="rounded-lg bg-blue-100/50 p-1.5 dark:bg-blue-900/30">
                  <svg
                    class="h-4 w-4 text-blue-600 dark:text-blue-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                    />
                  </svg>
                </div>
                Input Tokens
              </div>
              <div class="text-2xl font-bold text-blue-600 dark:text-blue-400">
                {formatNumber(stats()!.inputTokens)}
              </div>
            </div>
            <div class="rounded-xl border border-purple-100 bg-gradient-to-br from-purple-50/50 to-white p-4 shadow-sm hover:shadow-md dark:border-purple-900/30 dark:from-purple-900/10 dark:to-gray-800">
              <div class="mb-2 flex items-center gap-2 text-sm text-purple-600/80 dark:text-purple-400/80">
                <div class="rounded-lg bg-purple-100/50 p-1.5 dark:bg-purple-900/30">
                  <svg
                    class="h-4 w-4 rotate-180 text-purple-600 dark:text-purple-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                    />
                  </svg>
                </div>
                Output Tokens
              </div>
              <div class="text-2xl font-bold text-purple-600 dark:text-purple-400">
                {formatNumber(stats()!.outputTokens)}
              </div>
            </div>
            <div class="rounded-xl border border-green-100 bg-gradient-to-br from-green-50/50 to-white p-4 shadow-sm hover:shadow-md dark:border-green-900/30 dark:from-green-900/10 dark:to-gray-800">
              <div class="mb-2 flex items-center gap-2 text-sm text-green-600/80 dark:text-green-400/80">
                <div class="rounded-lg bg-green-100/50 p-1.5 dark:bg-green-900/30">
                  <svg
                    class="h-4 w-4 text-green-600 dark:text-green-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                    />
                  </svg>
                </div>
                {t("dashboard.kpi.successRate")}
              </div>
              <div class="text-2xl font-bold text-green-600 dark:text-green-400">
                {successRate()}%
              </div>
            </div>
            <div class="rounded-xl border border-orange-100 bg-gradient-to-br from-orange-50/50 to-white p-4 shadow-sm hover:shadow-md dark:border-orange-900/30 dark:from-orange-900/10 dark:to-gray-800">
              <div class="mb-2 flex items-center gap-2 text-sm text-orange-600/80 dark:text-orange-400/80">
                <div class="rounded-lg bg-orange-100/50 p-1.5 dark:bg-orange-900/30">
                  <svg
                    class="h-4 w-4 text-orange-600 dark:text-orange-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                    />
                  </svg>
                </div>
                {t("dashboard.kpi.estimatedCost")}
              </div>
              <div class="text-2xl font-bold text-orange-600 dark:text-orange-400">
                {formatCost(estimatedCost())}
              </div>
            </div>
          </div>

          {/* Charts: Request Trend + Token Usage */}
          <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 lg:col-span-2">
              <h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-800 dark:text-white">
                <svg
                  class="h-5 w-5 text-purple-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                  />
                </svg>
                {t("analytics.requestTrends")}
              </h2>
              <div class="h-64">
                <Show
                  fallback={
                    <div class="flex h-full items-center justify-center text-gray-400">
                      {t("analytics.noTrendData")}
                    </div>
                  }
                  when={requestsData().length > 0}
                >
                  <EChartsWrapper option={requestAreaOption()} />
                </Show>
              </div>
            </div>
            <div class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-800 dark:text-white">
                <svg
                  class="h-5 w-5 text-blue-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                  />
                  <path
                    d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                  />
                </svg>
                {t("analytics.modelBreakdown")}
              </h2>
              <div class="h-64">
                <Show
                  fallback={
                    <div class="flex h-full items-center justify-center text-gray-400">
                      {t("analytics.noModelData")}
                    </div>
                  }
                  when={knownModels().length > 0}
                >
                  <EChartsWrapper option={modelPieOption()} />
                </Show>
              </div>
            </div>
          </div>

          {/* Token Usage Trend */}
          <Show when={tokensData().length > 0}>
            <div class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <h2 class="mb-3 flex items-center gap-2 text-lg font-semibold text-gray-800 dark:text-white">
                <svg
                  class="h-5 w-5 text-blue-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                  />
                </svg>
                {t("analytics.tokenUsage")}
              </h2>
              <div class="h-64">
                <EChartsWrapper option={tokenBarOption()} />
              </div>
            </div>
          </Show>

          {/* Model Detail Table */}
          <Show when={knownModels().length > 0}>
            <div class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <h2 class="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-800 dark:text-white">
                <svg
                  class="h-5 w-5 text-purple-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                  />
                </svg>
                {t("analytics.modelUsage")}
              </h2>
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-gray-200 dark:border-gray-700">
                      <th class="px-4 py-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        {t("analytics.model")}
                      </th>
                      <th class="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                        {t("analytics.requests")}
                      </th>
                      <th class="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                        {t("analytics.in")}
                      </th>
                      <th class="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                        {t("analytics.out")}
                      </th>
                      <th class="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                        {t("analytics.tokens")}
                      </th>
                      <th class="hidden px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400 lg:table-cell">
                        {t("analytics.cache")}
                      </th>
                      <th class="px-4 py-3 text-right font-medium text-gray-500 dark:text-gray-400">
                        %
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={knownModels().slice(0, 15)}>
                      {(model, idx) => {
                        const pct = () =>
                          stats() && stats()!.totalTokens > 0
                            ? ((model.tokens / stats()!.totalTokens) * 100).toFixed(1)
                            : "0";
                        return (
                          <tr class="border-b border-gray-100 hover:bg-gray-50 dark:border-gray-700/50 dark:hover:bg-gray-700/30">
                            <td class="px-4 py-3">
                              <div class="flex items-center gap-2">
                                <div
                                  class="h-3 w-3 rounded-full"
                                  style={{
                                    "background-color": MODEL_COLORS[idx() % MODEL_COLORS.length],
                                  }}
                                />
                                <span class="font-medium text-gray-800 dark:text-white">
                                  {model.model}
                                </span>
                              </div>
                            </td>
                            <td class="px-4 py-3 text-right text-gray-600 dark:text-gray-300">
                              {model.requests.toLocaleString()}
                            </td>
                            <td class="px-4 py-3 text-right text-blue-600">
                              {formatNumber(model.inputTokens)}
                            </td>
                            <td class="px-4 py-3 text-right text-purple-600">
                              {formatNumber(model.outputTokens)}
                            </td>
                            <td class="px-4 py-3 text-right font-semibold text-gray-800 dark:text-white">
                              {formatNumber(model.tokens)}
                            </td>
                            <td class="hidden px-4 py-3 text-right text-gray-500 lg:table-cell">
                              {formatNumber(model.cachedTokens)}
                            </td>
                            <td class="px-4 py-3 text-right">
                              <div class="flex items-center justify-end gap-2">
                                <div class="h-2 w-16 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                                  <div
                                    class="h-2 rounded-full"
                                    style={{
                                      "background-color": MODEL_COLORS[idx() % MODEL_COLORS.length],
                                      width: `${pct()}%`,
                                    }}
                                  />
                                </div>
                                <span class="w-12 text-right text-gray-600 dark:text-gray-300">
                                  {pct()}%
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      }}
                    </For>
                  </tbody>
                </table>
              </div>
              <Show when={knownModels().length > 15}>
                <p class="mt-3 text-center text-xs text-gray-400">
                  {t("analytics.showingTop10Of")} {knownModels().length} {t("analytics.models")}
                </p>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
