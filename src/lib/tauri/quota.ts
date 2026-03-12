import { invoke } from "@tauri-apps/api/core";

// Antigravity Quota
export interface ModelQuota {
  displayName: string;
  model: string;
  remainingPercent: number;
  resetTime?: string;
}

export interface AntigravityQuotaResult {
  accountEmail: string;
  error?: string;
  fetchedAt: string;
  quotas: ModelQuota[];
}

export interface CodexQuotaResult {
  accountEmail: string;
  creditsBalance?: number;
  creditsUnlimited: boolean;
  error?: string;
  fetchedAt: string;
  hasCredits: boolean;
  planType: string;
  primaryResetAt?: number;
  primaryUsedPercent: number;
  secondaryResetAt?: number;
  secondaryUsedPercent: number;
}

export interface CopilotQuotaResult {
  accountLogin: string;
  chatPercent: number;
  error?: string;
  fetchedAt: string;
  plan: string;
  premiumInteractionsPercent: number;
}

export interface ClaudeQuotaResult {
  accountEmail: string;
  error?: string;
  extraUsageLimit?: number;
  extraUsageSpend?: number;
  fetchedAt: string;
  fiveHourPercent: number;
  fiveHourResetAt?: number;
  plan: string;
  sevenDayPercent: number;
  sevenDayResetAt?: number;
}

export async function fetchAntigravityQuota(): Promise<AntigravityQuotaResult[]> {
  return invoke("fetch_antigravity_quota");
}

export async function fetchCodexQuota(): Promise<CodexQuotaResult[]> {
  return invoke("fetch_codex_quota");
}

export async function fetchCopilotQuota(): Promise<CopilotQuotaResult[]> {
  return invoke("fetch_copilot_quota");
}

export async function fetchClaudeQuota(): Promise<ClaudeQuotaResult[]> {
  return invoke("fetch_claude_quota");
}
