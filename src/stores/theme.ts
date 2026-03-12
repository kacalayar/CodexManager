import { createSignal, createRoot, createEffect } from "solid-js";

export type Theme = "light" | "dark" | "system";

function getSystemTheme(): "light" | "dark" {
  if (typeof window !== "undefined") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

function createThemeStore() {
  // Load saved preference or default to system
  const saved = localStorage.getItem("theme") as Theme | null;
  const [theme, setTheme] = createSignal<Theme>(saved || "system");

  // Resolved theme (what's actually applied)
  const resolvedTheme = () => {
    const current = theme();
    if (current === "system") {
      return getSystemTheme();
    }
    return current;
  };

  // Apply theme to document
  createEffect(() => {
    const resolved = resolvedTheme();
    const root = document.documentElement;

    if (resolved === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }

    // Save preference
    localStorage.setItem("theme", theme());
  });

  // Listen for system theme changes
  if (typeof window !== "undefined") {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", () => {
      // Only re-apply if using system theme
      if (theme() === "system") {
        const resolved = getSystemTheme();
        if (resolved === "dark") {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
      }
    });
  }

  const cycleTheme = () => {
    const current = theme();
    if (current === "system") {
      setTheme("light");
    } else if (current === "light") {
      setTheme("dark");
    } else {
      setTheme("system");
    }
  };

  return {
    cycleTheme,
    resolvedTheme,
    setTheme,
    theme,
  };
}

export const themeStore = createRoot(createThemeStore);
