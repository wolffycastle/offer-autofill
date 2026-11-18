/**
 * chrome.storage.local 封装：负责多套求职资料、大模型设置、偏好项、跨站通用记忆及本机站点记忆缓存。
 */

import { DEFAULT_LLM_CONFIG } from "./llm-client.js";
import { createEmptyProfile, normalizeProfile, setProfileValue } from "./profile-schema.js";

const STORAGE_KEYS = {
  PROFILES: "oa_profiles",
  ACTIVE_PROFILE_ID: "oa_active_profile_id",
  LLM_CONFIG: "oa_llm_config",
  PREFERENCES: "oa_preferences",
  LEARNED_MAPPINGS: "oa_learned_mappings",
  GLOBAL_RULES: "oa_global_learned_rules",
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
      globalLearnedRules: {},
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
    globalLearnedRules: raw[STORAGE_KEYS.GLOBAL_RULES] || {},
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

/**
 * 批量回写指定求职资料的空缺/补填字段到本机存储。
 */
export async function updateProfileFieldValues(profileId, updates = []) {
  const area = getArea();
  if (!area || !Array.isArray(updates) || updates.length === 0) return 0;

  const state = await loadAppState();
  const idx = state.profiles.findIndex((p) => p.id === profileId);
  const targetIdx = idx >= 0 ? idx : 0;
  const target = normalizeProfile(state.profiles[targetIdx]);

  let changed = 0;
  for (const { path, value } of updates) {
    if (path && value != null && String(value).trim() !== "") {
      if (setProfileValue(target, path, value)) {
        changed++;
      }
    }
  }
  if (changed > 0) {
    target.updatedAt = new Date().toISOString();
    state.profiles[targetIdx] = target;
    await saveProfiles(state.profiles, state.activeProfileId);
  }
  return changed;
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
  for (const { key, label, path, fixedValue } of entries) {
    if (key && (path || fixedValue)) {
      siteMap[key] = {
        label: label || key,
        ...(path ? { path } : {}),
        ...(fixedValue ? { fixedValue } : {}),
        updatedAt: new Date().toISOString(),
      };
    }
  }
  all[hostname] = siteMap;
  await area.set({ [STORAGE_KEYS.LEARNED_MAPPINGS]: all });
}

export async function deleteDomainLearnedMapping(hostname, key) {
  const area = getArea();
  if (!area || !hostname || !key) return;
  const raw = await area.get(STORAGE_KEYS.LEARNED_MAPPINGS);
  const all = raw[STORAGE_KEYS.LEARNED_MAPPINGS] || {};
  if (all[hostname]) {
    delete all[hostname][key];
    if (Object.keys(all[hostname]).length === 0) {
      delete all[hostname];
    }
    await area.set({ [STORAGE_KEYS.LEARNED_MAPPINGS]: all });
  }
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

export async function saveGlobalLearnedRules(entries = []) {
  const area = getArea();
  if (!area || entries.length === 0) return;
  const raw = await area.get(STORAGE_KEYS.GLOBAL_RULES);
  const rules = { ...(raw[STORAGE_KEYS.GLOBAL_RULES] || {}) };
  for (const { key, label, section, path, fixedValue } of entries) {
    if (key && (path || fixedValue)) {
      rules[key] = {
        label: label || key,
        section: section || "basic",
        ...(path ? { path } : {}),
        ...(fixedValue ? { fixedValue } : {}),
        updatedAt: new Date().toISOString(),
      };
    }
  }
  await area.set({ [STORAGE_KEYS.GLOBAL_RULES]: rules });
}

export async function deleteGlobalLearnedRule(key) {
  const area = getArea();
  if (!area || !key) return;
  const raw = await area.get(STORAGE_KEYS.GLOBAL_RULES);
  const rules = { ...(raw[STORAGE_KEYS.GLOBAL_RULES] || {}) };
  delete rules[key];
  await area.set({ [STORAGE_KEYS.GLOBAL_RULES]: rules });
}

export async function clearGlobalLearnedRules() {
  const area = getArea();
  if (!area) return;
  await area.set({ [STORAGE_KEYS.GLOBAL_RULES]: {} });
}
