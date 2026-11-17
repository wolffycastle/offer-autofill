/**
 * chrome.storage.local 封装：负责多套求职资料、大模型设置、偏好项及本机站点记忆缓存。
 */

import { DEFAULT_LLM_CONFIG } from "./llm-client.js";
import { createEmptyProfile, normalizeProfile } from "./profile-schema.js";

const STORAGE_KEYS = {
  PROFILES: "oa_profiles",
  ACTIVE_PROFILE_ID: "oa_active_profile_id",
  LLM_CONFIG: "oa_llm_config",
  PREFERENCES: "oa_preferences",
  LEARNED_MAPPINGS: "oa_learned_mappings",
};

export const DEFAULT_PREFERENCES = {
  useLLM: true,
  overwrite: false,
  autoExpandSections: true,
};

function getArea() {
  return typeof chrome !== "undefined" ? chrome?.storage?.local : null;
}

export async function loadAppState() {
  const area = getArea();
  if (!area) {
    const def = createEmptyProfile();
    return {
      profiles: [def],
      activeProfileId: def.id,
      llmConfig: { ...DEFAULT_LLM_CONFIG },
      preferences: { ...DEFAULT_PREFERENCES },
      learnedMappings: {},
    };
  }

  const raw = await area.get(Object.values(STORAGE_KEYS));
  let profiles = Array.isArray(raw[STORAGE_KEYS.PROFILES])
    ? raw[STORAGE_KEYS.PROFILES].map(normalizeProfile)
    : [];

  if (profiles.length === 0) {
    profiles = [createEmptyProfile()];
  }

  const activeProfileId =
    raw[STORAGE_KEYS.ACTIVE_PROFILE_ID] &&
    profiles.some((p) => p.id === raw[STORAGE_KEYS.ACTIVE_PROFILE_ID])
      ? raw[STORAGE_KEYS.ACTIVE_PROFILE_ID]
      : profiles[0].id;

  return {
    profiles,
    activeProfileId,
    llmConfig: { ...DEFAULT_LLM_CONFIG, ...(raw[STORAGE_KEYS.LLM_CONFIG] || {}) },
    preferences: { ...DEFAULT_PREFERENCES, ...(raw[STORAGE_KEYS.PREFERENCES] || {}) },
    learnedMappings: raw[STORAGE_KEYS.LEARNED_MAPPINGS] || {},
  };
}

export async function saveProfiles(profiles, activeProfileId) {
  const area = getArea();
  if (!area) return;
  const normalized = profiles.map(normalizeProfile);
  await area.set({
    [STORAGE_KEYS.PROFILES]: normalized,
    ...(activeProfileId ? { [STORAGE_KEYS.ACTIVE_PROFILE_ID]: activeProfileId } : {}),
  });
}

export async function setActiveProfileId(activeProfileId) {
  const area = getArea();
  if (!area) return;
  await area.set({ [STORAGE_KEYS.ACTIVE_PROFILE_ID]: activeProfileId });
}

export async function saveLlmConfig(llmConfig) {
  const area = getArea();
  if (!area) return;
  await area.set({
    [STORAGE_KEYS.LLM_CONFIG]: { ...DEFAULT_LLM_CONFIG, ...llmConfig },
  });
}

export async function savePreferences(prefs) {
  const area = getArea();
  if (!area) return;
  await area.set({
    [STORAGE_KEYS.PREFERENCES]: { ...DEFAULT_PREFERENCES, ...prefs },
  });
}

export async function saveLearnedDomainMappings(hostname, entries = []) {
  const area = getArea();
  if (!area || !hostname || entries.length === 0) return;
  const raw = await area.get(STORAGE_KEYS.LEARNED_MAPPINGS);
  const all = raw[STORAGE_KEYS.LEARNED_MAPPINGS] || {};
  const siteMap = { ...(all[hostname] || {}) };
  for (const { key, path } of entries) {
    if (key && path) {
      siteMap[key] = { path, updatedAt: new Date().toISOString() };
    }
  }
  all[hostname] = siteMap;
  await area.set({ [STORAGE_KEYS.LEARNED_MAPPINGS]: all });
}

export async function clearLearnedMappings(hostname = null) {
  const area = getArea();
  if (!area) return;
  if (!hostname) {
    await area.set({ [STORAGE_KEYS.LEARNED_MAPPINGS]: {} });
    return;
  }
  const raw = await area.get(STORAGE_KEYS.LEARNED_MAPPINGS);
  const all = raw[STORAGE_KEYS.LEARNED_MAPPINGS] || {};
  delete all[hostname];
  await area.set({ [STORAGE_KEYS.LEARNED_MAPPINGS]: all });
}
