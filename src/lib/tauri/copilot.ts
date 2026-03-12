import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CopilotStatusMap } from "./models";

function normalizeCopilotStatusMap(payload: CopilotStatusMap): CopilotStatusMap {
  return {
    instances: payload.instances || payload.statuses || {},
  };
}

// Legacy CopilotStatus (for backwards compatibility with single instance)
export interface CopilotStatus {
  authenticated: boolean;
  endpoint: string;
  githubUsername?: string;
  id: string;
  port: number;
  running: boolean;
}

// Auth required event payload
export interface CopilotAuthRequiredEvent {
  instanceId: string;
  message: string;
}

// Default CopilotStatus for backwards compatibility
export const defaultCopilotStatus: CopilotStatus = {
  authenticated: false,
  endpoint: "http://localhost:4141",
  githubUsername: undefined,
  id: "",
  port: 4141,
  running: false,
};

// Copilot API detection result
export interface CopilotApiDetection {
  checkedCopilotPaths: string[];
  checkedNodePaths: string[];
  copilotBin?: string; // Path to copilot-api binary (if installed)
  installed: boolean;
  nodeAvailable: boolean;
  nodeBin?: string; // Path to node binary actually used
  npmBin?: string; // Path to npm binary (for installs)
  npxBin?: string; // Path to npx binary (for fallback)
  version?: string;
}

// Copilot API install result
export interface CopilotApiInstallResult {
  message: string;
  success: boolean;
  version?: string;
}

// ============================================
// Legacy Single-Instance Functions (for backwards compatibility)
// ============================================

export async function getCopilotStatus(): Promise<CopilotStatus> {
  return invoke("get_copilot_status");
}

export async function startCopilot(): Promise<CopilotStatus> {
  return invoke("start_copilot");
}

export async function stopCopilot(): Promise<CopilotStatus> {
  return invoke("stop_copilot");
}

export async function checkCopilotHealth(): Promise<CopilotStatus> {
  return invoke("check_copilot_health");
}

// ============================================
// Multi-Instance Functions
// ============================================

export async function getAllCopilotStatuses(): Promise<CopilotStatusMap> {
  const result = await invoke<CopilotStatusMap>("get_all_copilot_statuses");
  return normalizeCopilotStatusMap(result);
}

export async function startCopilotInstance(instanceId: string): Promise<CopilotStatus> {
  return invoke("start_copilot_instance", { instanceId });
}

export async function stopCopilotInstance(instanceId: string): Promise<CopilotStatus> {
  return invoke("stop_copilot_instance", { instanceId });
}

export async function stopAllCopilotInstances(): Promise<void> {
  return invoke("stop_all_copilot_instances");
}

// ============================================
// Detection & Installation
// ============================================

export async function detectCopilotApi(): Promise<CopilotApiDetection> {
  return invoke("detect_copilot_api");
}

export async function installCopilotApi(): Promise<CopilotApiInstallResult> {
  return invoke("install_copilot_api");
}

// ============================================
// Event Listeners
// ============================================

export async function onCopilotStatusChanged(
  callback: (status: CopilotStatus) => void,
): Promise<UnlistenFn> {
  return listen<CopilotStatus>("copilot-status-changed", (event) => {
    callback(event.payload);
  });
}

export async function onCopilotStatusesChanged(
  callback: (statuses: CopilotStatusMap) => void,
): Promise<UnlistenFn> {
  return listen<CopilotStatusMap>("copilot-statuses-changed", (event) => {
    callback(normalizeCopilotStatusMap(event.payload));
  });
}

export async function onCopilotAuthRequired(
  callback: (event: CopilotAuthRequiredEvent) => void,
): Promise<UnlistenFn> {
  return listen<CopilotAuthRequiredEvent | string>("copilot-auth-required", (event) => {
    // Handle both old (string) and new (object) formats for backwards compatibility
    if (typeof event.payload === "string") {
      callback({ instanceId: "", message: event.payload });
    } else {
      callback(event.payload);
    }
  });
}
