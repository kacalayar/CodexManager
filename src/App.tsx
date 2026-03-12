import { onCleanup, onMount, Show } from "solid-js";
import { CommandPalette } from "./components/CommandPalette";
import { Sidebar } from "./components/Sidebar";
import { ToastContainer } from "./components/ui";
import { useI18n } from "./i18n";
import {
  AnalyticsPage,
  ApiKeysPage,
  AuthFilesPage,
  DashboardPage,
  LogViewerPage,
  SettingsPage,
} from "./pages";
import { appStore } from "./stores/app";
import { themeStore } from "./stores/theme";

function App() {
  const { currentPage, initialize, isInitialized, setCurrentPage } = appStore;
  const { t } = useI18n();

  onMount(() => {
    initialize();

    // Listen for navigation events from child components
    const handleNavigateToSettings = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tab) {
        appStore.setSettingsTab(detail.tab);
      }
      setCurrentPage("settings");
    };
    window.addEventListener("navigate-to-settings", handleNavigateToSettings);
    onCleanup(() => {
      window.removeEventListener("navigate-to-settings", handleNavigateToSettings);
    });
  });

  return (
    <>
      {!isInitialized() ? (
        <div class="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
          <div class="text-center">
            <div class="mx-auto mb-4 flex h-16 w-16 animate-pulse items-center justify-center rounded-2xl">
              <img
                alt="CodexManager Logo"
                class="h-16 w-16 rounded-2xl object-contain"
                src={
                  themeStore.resolvedTheme() === "dark"
                    ? "/proxypal-white.png"
                    : "/proxypal-black.png"
                }
              />
            </div>
            <p class="text-gray-500 dark:text-gray-400">{t("app.loading")}</p>
          </div>
        </div>
      ) : (
        <>
          <Sidebar />
          <div
            classList={{
              "pl-16": !appStore.sidebarExpanded(),
              "pl-48": appStore.sidebarExpanded(),
            }}
          >
            <div classList={{ hidden: currentPage() !== "dashboard" }}>
              <DashboardPage />
            </div>
            <div classList={{ hidden: currentPage() !== "settings" }}>
              <SettingsPage />
            </div>
            <Show when={currentPage() === "api-keys"}>
              <ApiKeysPage />
            </Show>
            <Show when={currentPage() === "auth-files"}>
              <AuthFilesPage />
            </Show>
            <Show when={currentPage() === "logs"}>
              <LogViewerPage />
            </Show>
            <Show when={currentPage() === "analytics"}>
              <AnalyticsPage />
            </Show>
          </div>
        </>
      )}
      <ToastContainer />
      <CommandPalette />
    </>
  );
}

export default App;
