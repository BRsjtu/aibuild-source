const FORM_STORAGE_KEY = 'weiguang-space-form-v1'
const HISTORY_STORAGE_KEY = 'weiguang-space-history-v1'
const CURRENT_PLAN_STORAGE_KEY = 'weiguang-space-current-plan-v1'
const PENDING_CASE_STORAGE_KEY = 'weiguang-space-pending-case-v1'
const DEFAULT_BASE_URL = 'http://127.0.0.1:3010/weiguang'
const LEGACY_BASE_URLS = [
  'http://127.0.0.1:3010/weiguang',
  'http://127.0.0.1:3010/weiguang',
  'https://yimaweilai.top/weiguang',
]

function normalizeBaseUrl(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '')
  return LEGACY_BASE_URLS.includes(normalized) ? DEFAULT_BASE_URL : normalized
}

function safeGetStorage(key, fallback) {
  try {
    const value = wx.getStorageSync(key)
    return value === undefined || value === null || value === '' ? fallback : value
  } catch (error) {
    return fallback
  }
}

function safeSetStorage(key, value) {
  try {
    wx.setStorageSync(key, value)
    return true
  } catch (error) {
    return false
  }
}

function safeRemoveStorage(key) {
  try {
    wx.removeStorageSync(key)
    return true
  } catch (error) {
    return false
  }
}

function formatDisplayLabel(primary, custom) {
  const customValue = String(custom || '').trim()

  if (customValue) {
    return customValue
  }

  return String(primary || '').trim()
}

function getConfiguredBaseUrl() {
  const form = safeGetStorage(FORM_STORAGE_KEY, {})
  return normalizeBaseUrl((form && form.baseUrl) || DEFAULT_BASE_URL) || DEFAULT_BASE_URL
}

function buildPlanTitle(record) {
  const servicePeople = String(record.servicePeople || '基层休息空间').trim()
  const spaceType = String(record.spaceType || '改造方案').trim()
  return `${servicePeople}${spaceType}方案`
}

function normalizeRenderViews(record) {
  const list = []

  if (Array.isArray(record && record.renderViews)) {
    record.renderViews.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        return
      }

      const imageUrl = String(item.imageUrl || item.renderImageUrl || '').trim()
      const imageId = String(item.imageId || item.renderImageId || '').trim()
      const imagePath = String(item.imagePath || item.displayImagePath || '').trim()
      const sourceIndex = Number.isFinite(Number(item.sourceIndex)) ? Number(item.sourceIndex) : index

      if (!imageUrl && !imageId && !imagePath) {
        return
      }

      list.push({
        sourceIndex,
        title:
          Array.isArray(record && record.renderViews) && record.renderViews.length <= 1
            ? '效果图'
            : `视角 ${sourceIndex + 1}`,
        imageId,
        imageUrl,
        imagePath,
        isPrimary: Boolean(item.isPrimary),
      })
    })
  }

  if (!list.length) {
    const legacyImageUrl = String((record && record.renderImageUrl) || '').trim()
    const legacyImageId = String((record && record.renderImageId) || '').trim()
    const legacyImagePath = String((record && record.renderImagePath) || '').trim()

    if (legacyImageUrl || legacyImageId || legacyImagePath) {
      list.push({
        sourceIndex: 0,
        title: '效果图',
        imageId: legacyImageId,
        imageUrl: legacyImageUrl,
        imagePath: legacyImagePath,
        isPrimary: true,
      })
    }
  }

  if (!list.some((item) => item.isPrimary) && list.length) {
    list[0].isPrimary = true
  }

  return list.sort((a, b) => a.sourceIndex - b.sourceIndex)
}

function normalizeImagePathList(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
}

function normalizePlanRecord(record) {
  if (!record || typeof record !== 'object') {
    return null
  }

  const createdAt = Number(record.createdAt) || Date.now()
  const updatedAt = Number(record.updatedAt) || createdAt
  const selectedFurnitureLabels = Array.isArray(record.selectedFurnitureLabels)
    ? record.selectedFurnitureLabels
    : []
  const renderViews = normalizeRenderViews(record)
  const primaryRenderView = renderViews.find((item) => item.isPrimary) || renderViews[0] || null

  return {
    id: String(record.id || `${createdAt}-${Math.random().toString(16).slice(2, 8)}`),
    title: String(record.title || buildPlanTitle(record)),
    createdAt,
    updatedAt,
    baseUrl: normalizeBaseUrl(record.baseUrl || DEFAULT_BASE_URL) || DEFAULT_BASE_URL,
    servicePeople: String(record.servicePeople || ''),
    servicePeopleCustom: String(record.servicePeopleCustom || ''),
    spaceType: String(record.spaceType || ''),
    spaceTypeCustom: String(record.spaceTypeCustom || ''),
    areaText: String(record.areaText || ''),
    budgetRange: String(record.budgetRange || ''),
    budgetRangeCustom: String(record.budgetRangeCustom || ''),
    coreNeeds: String(record.coreNeeds || ''),
    constraints: String(record.constraints || ''),
    selectedFurnitureIds: Array.isArray(record.selectedFurnitureIds) ? record.selectedFurnitureIds : [],
    selectedFurnitureLabels,
    selectedFurnitureStyleIds: Array.isArray(record.selectedFurnitureStyleIds)
      ? record.selectedFurnitureStyleIds
      : [],
    furnitureStyleText: String(record.furnitureStyleText || ''),
    photoPaths: normalizeImagePathList(record.photoPaths || record.originalPhotoPaths),
    primaryViewIndex: Number.isFinite(Number(record.primaryViewIndex))
      ? Number(record.primaryViewIndex)
      : 0,
    floorPlanImageId: String(record.floorPlanImageId || ''),
    floorPlanImageUrl: String(record.floorPlanImageUrl || ''),
    floorPlanImagePath: String(record.floorPlanImagePath || record.floorPlanDisplayImagePath || ''),
    renderImageId: String((primaryRenderView && primaryRenderView.imageId) || record.renderImageId || ''),
    renderImageUrl: String((primaryRenderView && primaryRenderView.imageUrl) || record.renderImageUrl || ''),
    renderImagePath: String((primaryRenderView && primaryRenderView.imagePath) || record.renderImagePath || ''),
    renderViews,
    designText: String(record.designText || ''),
    finalDesignText: String(record.finalDesignText || ''),
    finalDesignPrompt: String(record.finalDesignPrompt || ''),
    coverImageUrl: String(
      record.coverImageUrl ||
        (primaryRenderView && primaryRenderView.imageUrl) ||
        record.renderImageUrl ||
        record.floorPlanImageUrl ||
        ''
    ),
  }
}

function buildPlanRecord(record) {
  return normalizePlanRecord(record)
}

function loadHistoryRecords() {
  const records = safeGetStorage(HISTORY_STORAGE_KEY, [])

  if (!Array.isArray(records)) {
    return []
  }

  return records.map(normalizePlanRecord).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt)
}

function saveHistoryRecords(records) {
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizePlanRecord)
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  safeSetStorage(HISTORY_STORAGE_KEY, normalized)
  return normalized
}

function upsertHistoryRecord(record) {
  const normalized = normalizePlanRecord(record)

  if (!normalized) {
    return null
  }

  const existing = loadHistoryRecords().filter((item) => item.id !== normalized.id)
  existing.unshift(normalized)
  saveHistoryRecords(existing.slice(0, 50))
  return normalized
}

function loadCurrentPlanRecord() {
  return normalizePlanRecord(safeGetStorage(CURRENT_PLAN_STORAGE_KEY, null))
}

function saveCurrentPlanRecord(record) {
  const normalized = normalizePlanRecord(record)

  if (!normalized) {
    return null
  }

  safeSetStorage(CURRENT_PLAN_STORAGE_KEY, normalized)
  return normalized
}

function removeCurrentPlanRecord() {
  safeRemoveStorage(CURRENT_PLAN_STORAGE_KEY)
}

function getPlanRecordById(id) {
  const recordId = String(id || '').trim()

  if (!recordId) {
    return loadCurrentPlanRecord()
  }

  const current = loadCurrentPlanRecord()

  if (current && current.id === recordId) {
    return current
  }

  return loadHistoryRecords().find((item) => item.id === recordId) || null
}

function savePendingCasePreset(caseItem) {
  safeSetStorage(PENDING_CASE_STORAGE_KEY, caseItem || null)
}

function consumePendingCasePreset() {
  const preset = safeGetStorage(PENDING_CASE_STORAGE_KEY, null)
  safeRemoveStorage(PENDING_CASE_STORAGE_KEY)
  return preset
}

function buildPdfPayloadFromPlanRecord(record) {
  const normalized = normalizePlanRecord(record)

  if (!normalized) {
    return null
  }

  return {
    servicePeople: normalized.servicePeople,
    spaceType: normalized.spaceType,
    areaText: normalized.areaText,
    budgetRange: normalized.budgetRange,
    coreNeeds: normalized.coreNeeds,
    constraints: normalized.constraints,
    selectedFurnitureLabels: normalized.selectedFurnitureLabels,
    furnitureStyleText: normalized.furnitureStyleText,
    floorPlanImageId: normalized.floorPlanImageId,
    renderImageId: normalized.renderImageId,
    renderImageIds: normalized.renderViews.map((item) => item.imageId).filter(Boolean),
    designText: normalized.designText,
    finalDesignText: normalized.finalDesignText,
    exportedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  FORM_STORAGE_KEY,
  formatDisplayLabel,
  getConfiguredBaseUrl,
  buildPlanRecord,
  buildPlanTitle,
  loadHistoryRecords,
  saveHistoryRecords,
  upsertHistoryRecord,
  loadCurrentPlanRecord,
  saveCurrentPlanRecord,
  removeCurrentPlanRecord,
  getPlanRecordById,
  savePendingCasePreset,
  consumePendingCasePreset,
  buildPdfPayloadFromPlanRecord,
}
