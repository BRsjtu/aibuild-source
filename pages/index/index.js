const STORAGE_KEY = 'weiguang-space-form-v1'
const ACTIVE_TASK_STORAGE_KEY = 'weiguang-space-active-task-v1'
const THEME_STORAGE_KEY = 'weiguang-space-theme-v1'
const {
  DEFAULT_BASE_URL,
  buildPlanRecord,
  loadCurrentPlanRecord,
  saveCurrentPlanRecord,
  upsertHistoryRecord,
  consumePendingCasePreset,
} = require('../../lib/weiguang-data')
const {
  downloadImageForDisplay: downloadRemoteImageForDisplay,
} = require('../../lib/image-display')
const {
  getMimeTypeFromPath,
  readFileAsBase64,
  readImageFile,
} = require('../../lib/image-file')
const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
const DEFAULT_TEXT_MODEL = 'deepseek-v4-flash'
const ESTIMATED_RENDER_MINUTES = { min: 3, max: 5 }
const ESTIMATED_FLOOR_MINUTES = { min: 2, max: 3 }
const ESTIMATED_DESIGN_MINUTES = { min: 0, max: 1 }
const EDITOR_AREA_WIDTH_RPX = 640
const EDITOR_AREA_HEIGHT_RPX = 520
const SERVICE_PEOPLE_OTHER = '其他'
const SERVICE_PEOPLE_OPTIONS = [
  '保洁员',
  '快递员',
  '保安',
  '环卫工',
  '外卖骑手',
  '廉租房住户',
  '宿舍管理员',
  '社区志愿者',
  SERVICE_PEOPLE_OTHER,
]
const SPACE_TYPE_OPTIONS = [
  '休息室',
  '工具房',
  '值班室',
  '宿舍单间',
  '驿站角落',
  '厨房',
  '活动室',
]
const BUDGET_RANGE_OPTIONS = [
  '3000 元以内',
  '3000-8000 元',
  '8000-2 万元',
  '2-5 万元',
  '5 万元以上',
  '待定 / 以物资捐赠为主',
]
const MAX_SPACE_PHOTOS = 9
const THEME_BLUE = 'blue'
const THEME_YELLOW = 'yellow'
const DEFAULT_THEME = THEME_YELLOW
const THEME_CONFIG = {
  [THEME_BLUE]: {
    name: THEME_BLUE,
    className: '',
    label: '深蓝主题',
    toggleText: '切换暖黄',
    navColor: '#FFFFFF',
    navBackground: '#171C3A',
    accentColor: '#D62564',
  },
  [THEME_YELLOW]: {
    name: THEME_YELLOW,
    className: 'theme-yellow',
    label: '暖黄主题',
    toggleText: '切换深蓝',
    navColor: '#3F321A',
    navBackground: 'rgba(255, 242, 191, 0.88)',
    accentColor: '#C8892A',
  },
}

function getThemeConfig(themeName) {
  return THEME_CONFIG[themeName] || THEME_CONFIG[THEME_BLUE]
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function isImageModelName(value) {
  const model = String(value || '').trim()
  return /^gpt-image-/i.test(model) || /-image-/i.test(model)
}

function normalizeImageModel(value) {
  const model = String(value || '').trim()
  return model && !isImageModelName(model) ? model : DEFAULT_IMAGE_MODEL
}

function normalizeTextModel(value) {
  const model = String(value || '').trim()
  return model && !isImageModelName(model) ? model : DEFAULT_TEXT_MODEL
}

function inferLocalImageExtension(filePath) {
  const cleanPath = String(filePath || '').split('?')[0].split('#')[0].toLowerCase()
  const match = cleanPath.match(/\.([a-z0-9]+)$/)

  if (match && ['jpg', 'jpeg', 'png', 'webp', 'gif'].indexOf(match[1]) >= 0) {
    return match[1] === 'jpeg' ? 'jpg' : match[1]
  }

  return 'jpg'
}

function persistLocalPhotoForStorage(filePath) {
  const sourcePath = String(filePath || '').trim()
  const userDataPath = wx.env && wx.env.USER_DATA_PATH
  const fileSystem = wx.getFileSystemManager && wx.getFileSystemManager()

  if (!sourcePath || isHttpUrl(sourcePath) || !userDataPath || !fileSystem) {
    return Promise.resolve(sourcePath)
  }

  if (sourcePath.indexOf(userDataPath) === 0) {
    return Promise.resolve(sourcePath)
  }

  return new Promise((resolve) => {
    const extension = inferLocalImageExtension(sourcePath)
    const random = Math.random().toString(16).slice(2, 10)
    const targetPath = `${userDataPath}/weiguang-original-${Date.now()}-${random}.${extension}`

    fileSystem.copyFile({
      srcPath: sourcePath,
      destPath: targetPath,
      success() {
        resolve(targetPath)
      },
      fail() {
        resolve(sourcePath)
      },
    })
  })
}

function persistLocalPhotosForStorage(photoPaths) {
  return Promise.all((photoPaths || []).map((item) => persistLocalPhotoForStorage(item)))
}

function mergePhotoPaths(existingPaths, incomingPaths) {
  const merged = []

  ;[]
    .concat(existingPaths || [])
    .concat(incomingPaths || [])
    .forEach((item) => {
      const path = String(item || '').trim()

      if (!path || merged.indexOf(path) >= 0) {
        return
      }

      merged.push(path)
    })

  return merged.slice(0, MAX_SPACE_PHOTOS)
}

function clampPrimaryViewIndex(photoPaths, preferredIndex) {
  const length = Array.isArray(photoPaths) ? photoPaths.length : 0

  if (!length) {
    return 0
  }

  const numeric = Number(preferredIndex)

  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0
  }

  return Math.min(length - 1, Math.floor(numeric))
}

function buildOrderedPhotoPaths(photoPaths, primaryIndex) {
  const list = Array.isArray(photoPaths) ? photoPaths.slice() : []

  if (!list.length) {
    return []
  }

  const safeIndex = clampPrimaryViewIndex(list, primaryIndex)
  return [list[safeIndex]].concat(list.filter((_, index) => index !== safeIndex))
}

function buildRenderViewTitle(sourceIndex, totalCount, isPrimary) {
  if (totalCount <= 1) {
    return '效果图'
  }

  return `视角 ${sourceIndex + 1}`
}

function buildViewSpecificRenderPrompt(basePrompt, sourceIndex, totalCount, isPrimary) {
  const prefix = [
    `Primary camera rule: the first uploaded image is the exact target viewpoint for this render. This run is for view ${sourceIndex + 1} of ${totalCount}.`,
    'Any remaining uploaded room photos are auxiliary photos of the same room. Use them only to infer hidden geometry, furniture continuity, and spatial consistency.',
    'Additional furniture-style reference images may be attached after the room photos. Use those only as object/style guidance for the selected furniture, not as room viewpoints.',
    'Do not average viewpoints across images. The final output must preserve the framing and camera direction of the first uploaded image.',
    isPrimary
      ? 'This view is marked as the main presentation view, so prioritize clarity and realism while staying faithful to the original camera.'
      : 'This is a supplementary view, so keep the design consistent with the main scheme while preserving this specific camera angle.',
  ]

  return `${prefix.join('\n')}\n\n${String(basePrompt || '').trim()}`
}

function indexOfBudgetOption(budgetRange) {
  const idx = BUDGET_RANGE_OPTIONS.indexOf(budgetRange)
  return idx >= 0 ? idx : 0
}
const FURNITURE_OPTIONS = [
  { id: 'bunk_bed', label: '上下铺' },
  { id: 'folding_bed', label: '折叠床' },
  { id: 'locker', label: '储物柜' },
  { id: 'shelf', label: '置物架' },
  { id: 'water_dispenser', label: '饮水机' },
  { id: 'microwave', label: '微波炉' },
  { id: 'table', label: '桌子' },
  { id: 'chair', label: '椅子' },
  { id: 'charging_station', label: '充电区' },
  { id: 'sink', label: '洗手池' },
]
const FURNITURE_STYLE_TARGET_IDS = ['folding_bed', 'locker', 'shelf', 'table']
const FURNITURE_STYLE_LABEL_MAP = {
  folding_bed: '折叠床',
  locker: '储物柜',
  shelf: '置物架',
  table: '桌子',
}
const DEFAULT_FURNITURE_LIBRARY = [
  {
    id: 'folding_bed',
    label: '折叠床',
    category: '休息',
    icon: '床',
    color: '#FED7AA',
    accentColor: '#EA580C',
    defaultWidth: 180,
    defaultHeight: 76,
    defaultScale: 1,
    promptHint: '适合靠墙布置的折叠床，满足短暂休息需求',
  },
  {
    id: 'locker',
    label: '储物柜',
    category: '收纳',
    icon: '柜',
    color: '#C7D2FE',
    accentColor: '#4338CA',
    defaultWidth: 156,
    defaultHeight: 74,
    defaultScale: 1,
    promptHint: '带锁收纳柜，便于个人物品整理',
  },
  {
    id: 'water_dispenser',
    label: '饮水机',
    category: '补给',
    icon: '水',
    color: '#A7F3D0',
    accentColor: '#047857',
    defaultWidth: 138,
    defaultHeight: 70,
    defaultScale: 1,
    promptHint: '独立饮水位，靠近入口或角落更方便补给',
  },
  {
    id: 'charging_station',
    label: '充电区',
    category: '补给',
    icon: '电',
    color: '#E9D5FF',
    accentColor: '#7E22CE',
    defaultWidth: 150,
    defaultHeight: 72,
    defaultScale: 1,
    promptHint: '集中充电点位，建议靠墙并预留等候空间',
  },
]
const DEFAULT_CASE_STUDIES = [
  {
    id: 'guard-corner-upgrade',
    title: '门卫角落变暖心驿站',
    subtitle: '8 平米值班角落做出休息、饮水、充电三合一',
    spaceType: '值班室',
    targetUsers: '保安、保洁员',
    budgetRange: '3000-8000 元',
    tags: ['低成本', '值班室', '充电区'],
    highlight: '利用靠墙布置和折叠家具，让窄空间也能完成短时休息闭环。',
    summary: '保留原有门窗与通道，新增饮水台、充电位和储物矮柜，整体温暖克制。',
    coverImageUrl: '',
    beforeImageUrl: '',
  },
]
const DEFAULT_FORM = {
  baseUrl: 'http://127.0.0.1:3010/weiguang',
  imageModel: DEFAULT_IMAGE_MODEL,
  textModel: DEFAULT_TEXT_MODEL,
  aspectRatio: '4:3',
  imageSize: '1K',
  primaryViewIndex: 0,
  servicePeople: '保洁员',
  servicePeopleCustom: '',
  spaceType: '休息室',
  spaceTypeCustom: '',
  areaText: '10-15 平方米',
  budgetRange: '3000-8000 元',
  budgetRangeCustom: '',
  coreNeeds: '增加休息位、收纳位、饮水和充电区域，保留基本通行空间。',
  constraints: '预算克制，方便清洁维护，尽量利用现有墙体与门窗位置。',
  selectedFurnitureIds: ['folding_bed', 'locker', 'water_dispenser', 'charging_station'],
  selectedFurnitureStyleIds: [],
  customFurnitureStylePaths: {},
  furnitureStyleText: '',
  photoPaths: [],
}

function normalizeCachedBaseUrl(baseUrl) {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (normalized === 'http://127.0.0.1:3010/weiguang' || normalized === 'http://127.0.0.1:3010/weiguang' || normalized === 'https://yimaweilai.top/weiguang') {
    return DEFAULT_BASE_URL
  }
  return normalized || DEFAULT_BASE_URL
}

const FAKE_PROGRESS_STAGES = [
  {
    minElapsedMs: 0,
    maxPercent: 18,
    title: '正在分析空间结构',
    hint: '识别门窗、墙体方向和空间边界',
  },
  {
    minElapsedMs: 12000,
    maxPercent: 46,
    title: '正在生成 3D 效果图',
    hint: '尽量保持原图视角、取景和空间尺度',
  },
  {
    minElapsedMs: 32000,
    maxPercent: 78,
    title: '正在生成 2D 布局图',
    hint: '推演功能分区、家具排布和基础动线',
  },
  {
    minElapsedMs: 52000,
    maxPercent: 94,
    title: '正在整理设计说明',
    hint: '归纳空间改造建议与采购参考',
  },
]

function guessMimeFromPath(filePath) {
  const lower = String(filePath || '').toLowerCase()

  if (lower.endsWith('.png')) {
    return 'image/png'
  }

  if (lower.endsWith('.webp')) {
    return 'image/webp'
  }

  if (lower.endsWith('.gif')) {
    return 'image/gif'
  }

  return 'image/jpeg'
}

function readLocalFileBase64(filePath) {
  return readFileAsBase64(filePath)
}

async function buildExtraImagesJsonForUpload(photoPaths) {
  const paths = (photoPaths || []).slice(0, MAX_SPACE_PHOTOS - 1)
  const items = []

  for (let i = 0; i < paths.length; i += 1) {
    const p = paths[i]

    try {
      const data = await readLocalFileBase64(p)
      items.push({
        data,
        mimeType: guessMimeFromPath(p),
      })
    } catch (error) {
      console.error('[微光空间] buildExtraImagesJsonForUpload failed', p, error)
    }
  }

  return items.length ? JSON.stringify(items) : ''
}

async function buildFurnitureReferenceImagesJsonForUpload(customStylePaths) {
  const paths = Object.keys(customStylePaths || {})
    .map((key) => customStylePaths[key])
    .filter(Boolean)
  const items = []

  for (let i = 0; i < paths.length; i += 1) {
    const p = paths[i]

    try {
      const data = await readLocalFileBase64(p)
      items.push({
        data,
        mimeType: guessMimeFromPath(p),
      })
    } catch (error) {
      console.error('[微光空间] buildFurnitureReferenceImagesJsonForUpload failed', p, error)
    }
  }

  return items.length ? JSON.stringify(items) : ''
}

function getCustomOrFallback(customValue, fallbackValue) {
  const custom = String(customValue || '').trim()

  if (custom) {
    return custom
  }

  return String(fallbackValue || '').trim()
}

function getEffectiveServicePeople(form) {
  if (!form) {
    return ''
  }

  const custom = String(form.servicePeopleCustom || '').trim()

  if (custom) {
    return custom
  }

  if (form.servicePeople === SERVICE_PEOPLE_OTHER) {
    return '其他（未填写具体职业）'
  }

  return form.servicePeople || ''
}

function getEffectiveSpaceType(form) {
  if (!form) {
    return ''
  }

  return getCustomOrFallback(form.spaceTypeCustom, form.spaceType)
}

function getEffectiveBudgetRange(form) {
  if (!form) {
    return ''
  }

  return getCustomOrFallback(form.budgetRangeCustom, form.budgetRange)
}

function getDisplayLabel(primary, custom) {
  const customValue = String(custom || '').trim()

  if (customValue) {
    return customValue
  }

  return String(primary || '').trim()
}

function buildFurnitureOptions(selectedFurnitureIds) {
  return FURNITURE_OPTIONS.map((item) => ({
    ...item,
    checked: selectedFurnitureIds.indexOf(item.id) >= 0,
    styleConfigurable: FURNITURE_STYLE_TARGET_IDS.indexOf(item.id) >= 0,
  }))
}

function isFurnitureStyleTarget(furnitureId) {
  return FURNITURE_STYLE_TARGET_IDS.indexOf(furnitureId) >= 0
}

function normalizeFurnitureStyleGroups(groups) {
  if (!Array.isArray(groups)) {
    return []
  }

  return groups
    .map((group) => ({
      furnitureId: group.furnitureId || '',
      furnitureLabel: group.furnitureLabel || FURNITURE_STYLE_LABEL_MAP[group.furnitureId] || '',
      styles: Array.isArray(group.styles)
        ? group.styles.map((item, index) => ({
            id: item.id || `${group.furnitureId || 'style'}-${index + 1}`,
            furnitureId: group.furnitureId || '',
            label: item.label || `款式 ${index + 1}`,
            description: item.description || '',
            imageUrl: item.imageUrl || '',
            displayImagePath: item.displayImagePath || '',
            sourceUrl: item.sourceUrl || '',
            license: item.license || '',
            attribution: item.attribution || '',
          }))
        : [],
    }))
    .filter((group) => group.furnitureId && group.styles.length)
}

function flattenFurnitureStyleGroups(groups) {
  const items = []

  ;(groups || []).forEach((group) => {
    ;(group.styles || []).forEach((item) => {
      items.push({
        ...item,
        furnitureId: item.furnitureId || group.furnitureId,
        furnitureLabel: group.furnitureLabel || FURNITURE_STYLE_LABEL_MAP[group.furnitureId] || '',
      })
    })
  })

  return items
}

function getFurnitureStyleGroup(groups, furnitureId) {
  return (groups || []).find((group) => group.furnitureId === furnitureId) || null
}

function buildFurnitureStyleText(form, groups) {
  const selectedIds = Array.isArray(form.selectedFurnitureStyleIds)
    ? form.selectedFurnitureStyleIds
    : []
  const customPaths = form.customFurnitureStylePaths || {}
  const selectedMap = {}

  flattenFurnitureStyleGroups(groups).forEach((item) => {
    if (selectedIds.indexOf(item.id) >= 0) {
      selectedMap[item.furnitureId] = `${item.furnitureLabel || ''}-${item.label}`.replace(/^-/, '')
    }
  })

  Object.keys(customPaths || {}).forEach((furnitureId) => {
    if (customPaths[furnitureId]) {
      selectedMap[furnitureId] = `${FURNITURE_STYLE_LABEL_MAP[furnitureId] || furnitureId}-用户上传款式图`
    }
  })

  return FURNITURE_STYLE_TARGET_IDS.map((furnitureId) => selectedMap[furnitureId])
    .filter(Boolean)
    .join('、')
}

function buildFurnitureStyleSummaries(form, groups) {
  const selectedFurnitureIds = Array.isArray(form.selectedFurnitureIds)
    ? form.selectedFurnitureIds
    : []
  const selectedStyleIds = Array.isArray(form.selectedFurnitureStyleIds)
    ? form.selectedFurnitureStyleIds
    : []
  const customPaths = form.customFurnitureStylePaths || {}
  const styleItems = flattenFurnitureStyleGroups(groups)

  return FURNITURE_STYLE_TARGET_IDS.filter(
    (furnitureId) => selectedFurnitureIds.indexOf(furnitureId) >= 0
  ).map((furnitureId) => {
    const group = getFurnitureStyleGroup(groups, furnitureId)
    const selectedStyle = styleItems.find(
      (item) => item.furnitureId === furnitureId && selectedStyleIds.indexOf(item.id) >= 0
    )
    const customPath = customPaths[furnitureId] || ''
    const firstStyle = group && group.styles ? group.styles[0] : null
    const imageUrl =
      customPath || (selectedStyle && selectedStyle.imageUrl) || (firstStyle && firstStyle.imageUrl) || ''
    const displayImagePath =
      customPath ||
      (selectedStyle && selectedStyle.displayImagePath) ||
      (firstStyle && firstStyle.displayImagePath) ||
      ''

    return {
      furnitureId,
      label: FURNITURE_STYLE_LABEL_MAP[furnitureId] || (group && group.furnitureLabel) || furnitureId,
      summary: customPath
        ? '已上传自定义款式图'
        : selectedStyle
          ? selectedStyle.label
          : '未指定款式',
      imageUrl,
      displayImagePath,
      hasSelection: Boolean(customPath || selectedStyle),
    }
  })
}

async function hydrateFurnitureStyleGroupsForDisplay(groups) {
  return Promise.all(
    (groups || []).map(async (group) => ({
      ...group,
      styles: await Promise.all(
        (group.styles || []).map(async (item) => {
          const displayImagePath = item.imageUrl
            ? await downloadImageForDisplay(item.imageUrl).catch(() => '')
            : ''

          return {
            ...item,
            displayImagePath: /^https?:\/\//i.test(displayImagePath) ? '' : displayImagePath,
          }
        })
      ),
    }))
  )
}

function resolveServicePeoplePreset(targetUsers) {
  const normalized = String(targetUsers || '').trim()

  if (!normalized) {
    return {
      servicePeople: DEFAULT_FORM.servicePeople,
      servicePeopleCustom: '',
    }
  }

  if (SERVICE_PEOPLE_OPTIONS.indexOf(normalized) >= 0 && normalized !== SERVICE_PEOPLE_OTHER) {
    return {
      servicePeople: normalized,
      servicePeopleCustom: '',
    }
  }

  return {
    servicePeople: SERVICE_PEOPLE_OTHER,
    servicePeopleCustom: normalized,
  }
}

function formatFurnitureLabels(selectedFurnitureIds) {
  const labelMap = {}

  FURNITURE_OPTIONS.forEach((item) => {
    labelMap[item.id] = item.label
  })

  return selectedFurnitureIds
    .map((id) => labelMap[id])
    .filter(Boolean)
}

function multiPhotoHint(photoCount) {
  const n = Number(photoCount) || 0

  if (n <= 1) {
    return ''
  }

  return ` The user uploaded ${n} photos of the same space from different angles; synthesize them into one coherent understanding of the room.`
}

function buildFloorPlanPrompt(form) {
  const furnitureLabels = formatFurnitureLabels(form.selectedFurnitureIds)
  const mustHaveText = furnitureLabels.length > 0 ? furnitureLabels.join('、') : '基础休息与收纳设施'
  const photoCount = Array.isArray(form.photoPaths) ? form.photoPaths.length : 0
  const furnitureStyleText = String(form.furnitureStyleText || '').trim()

  return [
    'You are an expert humanitarian interior designer for low-cost functional renovation.',
    'Task: redesign the uploaded current space photo into a practical 2D floor plan for a public-welfare project.',
    `Target users: ${getEffectiveServicePeople(form) || 'frontline workers'}.`,
    `Space type: ${getEffectiveSpaceType(form) || 'rest room'}.`,
    `Approximate area: ${form.areaText || 'small space'}.`,
    `Budget range (guidance only): ${getEffectiveBudgetRange(form) || 'unspecified'}.`,
    `Core needs: ${form.coreNeeds || 'improve rest and storage efficiency'}.`,
    `Hard constraints: ${form.constraints || 'low budget, easy maintenance, safe circulation'}.`,
    `Must include: ${mustHaveText}.`,
    furnitureStyleText ? `Selected furniture style guidance: ${furnitureStyleText}.` : '',
    multiPhotoHint(photoCount),
    'Keep walls, doors, windows and rough spatial proportions consistent with the uploaded photo when reasonable.',
    'Strictly respect the real space limitation from the photo and the stated area.',
    'Do not enlarge the room, extend walls outward, or invent additional hidden area.',
    'For a very small room, use realistic compact furniture sizes and keep narrow but buildable circulation.',
    'If all requested furniture cannot fit safely, include only the essential subset instead of forcing everything in.',
    'Prioritize safety, circulation, and realistic scale over completeness.',
    'Maximize circulation, storage efficiency, and comfort for short breaks.',
    'Output a clean top-down 2D architectural layout.',
    'All visible labels, room names, functional annotations, and text inside the generated image must be in Simplified Chinese only.',
    'Do not output bilingual Chinese-English labels unless a proper noun must stay in its original language.',
    'Use clear zoning, visible furniture placement, and practical dimensions feeling.',
    'No people, no decorative fantasy elements, no dramatic lighting, no exploded axonometric view.',
    'Style keywords: top-down view, 2D floor plan, architectural drawing, practical, clean, legible, welfare design.',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildRenderPrompt(form) {
  const furnitureLabels = formatFurnitureLabels(form.selectedFurnitureIds)
  const mustHaveText = furnitureLabels.length > 0 ? furnitureLabels.join('、') : '基础休息与收纳设施'
  const photoCount = Array.isArray(form.photoPaths) ? form.photoPaths.length : 0
  const furnitureStyleText = String(form.furnitureStyleText || '').trim()
  const refLine =
    photoCount > 2
      ? `You will receive ${photoCount} original photos of the same space from different angles.`
      : photoCount === 2
        ? 'You will receive two original space photos from different angles.'
        : 'You will receive one original space photo.'

  return [
    refLine,
    'Task: create a realistic renovated interior render for the same space.',
    'The first uploaded image is always the main viewpoint to preserve in the final output.',
    'Use the original photo(s) as the primary and strict reference for camera angle, lens feeling, eye level, framing range, wall directions, door/window positions, ceiling height, and visible structural boundaries.',
    'If multiple original photos are provided, integrate them into one coherent understanding of the same room, but keep the final render close to the framing and viewpoint of the main photo.',
    'Additional furniture-style reference images may be attached after the original room photo(s). Use those reference images to guide the visible shape, material, color, and proportion of the specified furniture only.',
    'Do not treat furniture-style reference images as extra views of the room; they are product/style references, not spatial evidence.',
    'If any auxiliary planning drawing exists elsewhere in the workflow, treat it only as a weak planning reference and never let it override the real spatial envelope, scale, perspective, or visible details from the original photo(s).',
    'The final image should look like a renovated version of the original scene from nearly the same viewpoint and composition.',
    'Do not change the viewpoint to top-down, aerial, or a very different corner.',
    'Do not widen the room unnaturally or invent extra architectural space outside the visible framing.',
    `Target users: ${getEffectiveServicePeople(form) || 'frontline workers'}.`,
    `Space type: ${getEffectiveSpaceType(form) || 'rest room'}.`,
    `Budget range (guidance only): ${getEffectiveBudgetRange(form) || 'unspecified'}.`,
    `Must include: ${mustHaveText}.`,
    furnitureStyleText ? `Specified furniture styles: ${furnitureStyleText}. The selected furniture should visibly follow these reference images when it appears in the final render.` : '',
    `Design focus: ${form.coreNeeds || 'practical rest and storage upgrade'}.`,
    `Constraints: ${form.constraints || 'low budget, easy to clean, durable and humane'}.`,
    'Strictly respect the original space limitation and the stated area.',
    'Do not visually enlarge the room or invent more depth, width, or height than the original scene suggests.',
    'Keep furniture in realistic scale for a compact room.',
    'If the requested furniture set cannot fit in reality, show only the essential subset that can truly fit.',
    'Preserve compact circulation and the cramped feeling when the room is genuinely small.',
    'Show a believable small-space renovation with warm but restrained colors and practical materials.',
    'If any readable text, signs, labels, or functional annotations appear in the image, they must be in Simplified Chinese only.',
    'Do not use bilingual Chinese-English text unless a proper noun must remain untranslated.',
    'Use practical materials, compact storage, and buildable furniture sizes.',
    'Maintain visible perspective consistency with the original image.',
    'No people, no luxury hotel feeling, no surreal objects.',
    'Style keywords: same camera angle, same framing, renovated real scene, realistic interior render, welfare renovation, compact, humane, buildable.',
  ].join('\n')
}

function buildDesignPrompt(form, extraContext) {
  const furnitureLabels = formatFurnitureLabels(form.selectedFurnitureIds)
  const mustHaveText = furnitureLabels.length > 0 ? furnitureLabels.join('、') : '基础休息与收纳设施'
  const furnitureStyleText = String(form.furnitureStyleText || '').trim()

  return [
    '你是一位擅长公益空间改造的室内设计师，请基于以下信息输出中文设计说明。',
    '',
    '项目背景：',
    `- 服务人群：${getEffectiveServicePeople(form) || '未填写'}`,
    `- 空间类型：${getEffectiveSpaceType(form) || '未填写'}`,
    `- 大致面积：${form.areaText || '未填写'}`,
    `- 预算范围：${getEffectiveBudgetRange(form) || '未填写'}`,
    `- 核心诉求：${form.coreNeeds || '未填写'}`,
    `- 约束条件：${form.constraints || '未填写'}`,
    `- 重点配置：${mustHaveText}`,
    furnitureStyleText ? `- 指定家具款式：${furnitureStyleText}` : '',
    '',
    '请输出 4 个部分，并使用清晰的小标题：',
    '1. 方案定位：一句话概括这个改造方案的目标。',
    '2. 布局说明：说明功能分区、动线、主要家具布置逻辑。',
    '3. 改造建议：给出 3-5 条低成本、可施工、可维护的建议。',
    '4. 采购参考：给出一份精简采购清单，按“物品 - 作用”格式输出。',
    '',
    '要求：',
    '- 只使用中文输出，不要中英双语；除非是必要的专有名词，可保留原文。',
    '- 语言温暖、专业、克制，不要夸张宣传。',
    '- 强调对基层劳动者友好、易清洁、易维护、便于休息。',
    '- 不能编造超大面积、昂贵材料或复杂施工。',
    '',
    '补充上下文：',
    extraContext || '无',
  ].join('\n')
}

function requestBackendJson({ baseUrl, path, data, timeout = 180000 }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${String(baseUrl || '').replace(/\/+$/, '')}${path}`,
      method: 'POST',
      timeout,
      header: {
        'Content-Type': 'application/json',
      },
      data,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data || {})
          return
        }

        reject(
          new Error(
            `后端请求失败。path=${path} status=${res.statusCode} detail=${JSON.stringify(res.data)}`
          )
        )
      },
      fail(err) {
        reject(
          new Error(
            `后端网络请求失败。path=${path} detail=${JSON.stringify(err)}`
          )
        )
      },
    })
  })
}

function requestBackendGet({ baseUrl, path, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${String(baseUrl || '').replace(/\/+$/, '')}${path}`,
      method: 'GET',
      timeout,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data || {})
          return
        }

        reject(
          new Error(
            `后端查询失败。path=${path} status=${res.statusCode} detail=${JSON.stringify(res.data)}`
          )
        )
      },
      fail(err) {
        reject(
          new Error(
            `后端查询失败。path=${path} detail=${JSON.stringify(err)}`
          )
        )
      },
    })
  })
}

function normalizeUploadFormData(formData) {
  const normalized = {}

  Object.keys(formData || {}).forEach((key) => {
    const value = formData[key]

    if (value === undefined || value === null) {
      return
    }

    normalized[key] = typeof value === 'string' ? value : JSON.stringify(value)
  })

  return normalized
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
}

function markdownToBlocks(markdownText) {
  const lines = String(markdownText || '').replace(/\r/g, '').split('\n')
  const blocks = []
  let listBlock = null

  function closeList() {
    if (listBlock) {
      blocks.push(listBlock)
      listBlock = null
    }
  }

  lines.forEach((rawLine) => {
    const line = rawLine.trim()

    if (!line) {
      closeList()
      return
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      closeList()
      blocks.push({
        type: 'heading',
        text: headingMatch[2],
        html: renderInlineMarkdown(headingMatch[2]),
      })
      return
    }

    const unorderedMatch = line.match(/^[-*]\s+(.*)$/)
    if (unorderedMatch) {
      if (!listBlock || listBlock.listType !== 'unordered') {
        closeList()
        listBlock = {
          type: 'list',
          listType: 'unordered',
          items: [],
        }
      }
      listBlock.items.push({
        order: listBlock.items.length + 1,
        text: unorderedMatch[1],
        html: renderInlineMarkdown(unorderedMatch[1]),
      })
      return
    }

    const orderedMatch = line.match(/^\d+\.\s+(.*)$/)
    if (orderedMatch) {
      if (!listBlock || listBlock.listType !== 'ordered') {
        closeList()
        listBlock = {
          type: 'list',
          listType: 'ordered',
          items: [],
        }
      }
      listBlock.items.push({
        order: listBlock.items.length + 1,
        text: orderedMatch[1],
        html: renderInlineMarkdown(orderedMatch[1]),
      })
      return
    }

    closeList()
    blocks.push({
      type: 'paragraph',
      text: line,
      html: renderInlineMarkdown(line),
    })
  })

  closeList()

  return blocks
}

function requestBackendMultipartUpload({
  baseUrl,
  path,
  filePath,
  name = 'image',
  formData,
  timeout = 180000,
}) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${String(baseUrl || '').replace(/\/+$/, '')}${path}`,
      filePath,
      name,
      timeout,
      formData: normalizeUploadFormData(formData),
      success(res) {
        let parsedData = {}

        try {
          parsedData = res.data ? JSON.parse(res.data) : {}
        } catch (error) {
          reject(
            new Error(
              `后端上传接口返回了非 JSON 内容。path=${path} detail=${String(res.data || '').slice(0, 500)}`
            )
          )
          return
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsedData)
          return
        }

        reject(
          new Error(
            `后端上传请求失败。path=${path} status=${res.statusCode} detail=${JSON.stringify(parsedData)}`
          )
        )
      },
      fail(err) {
        reject(
          new Error(
            `上传图片失败。path=${path} filePath=${filePath} detail=${JSON.stringify(err)}`
          )
        )
      },
    })
  })
}

async function requestBackendFileUpload(options) {
  try {
    return await requestBackendMultipartUpload(options)
  } catch (uploadError) {
    console.warn('[微光空间] multipart upload failed, fallback to JSON image request', {
      path: options.path,
      filePath: options.filePath,
      error: uploadError,
    })

    try {
      const image = await readImageFile(options.filePath)
      return await requestBackendJson({
        baseUrl: options.baseUrl,
        path: options.path,
        timeout: options.timeout || 180000,
        data: {
          ...(options.formData || {}),
          imageBase64: image.imageBase64,
          mimeType: image.mimeType || getMimeTypeFromPath(options.filePath),
          fileName: String(options.filePath || '').split('/').pop() || 'input.jpg',
        },
      })
    } catch (fallbackError) {
      const error = new Error(
        `图片上传和备用请求都失败。path=${options.path} detail=${fallbackError.message}`
      )
      error.uploadError = uploadError
      error.fallbackError = fallbackError
      throw error
    }
  }
}

function downloadImageForDisplay(imageUrl) {
  return downloadRemoteImageForDisplay(imageUrl)
}

function normalizeFurnitureLibraryItems(items) {
  if (!Array.isArray(items) || !items.length) {
    return DEFAULT_FURNITURE_LIBRARY
  }

  return items.map((item, index) => ({
    id: item.id || `furniture-${index + 1}`,
    label: item.label || `家具 ${index + 1}`,
    category: item.category || '未分类',
    icon: item.icon || '物',
    color: item.color || '#E5E7EB',
    accentColor: item.accentColor || '#374151',
    defaultWidth: Number(item.defaultWidth) > 0 ? Number(item.defaultWidth) : 156,
    defaultHeight: Number(item.defaultHeight) > 0 ? Number(item.defaultHeight) : 72,
    defaultScale: Number(item.defaultScale) > 0 ? Number(item.defaultScale) : 1,
    promptHint: item.promptHint || '',
  }))
}

function normalizeCaseStudies(items) {
  if (!Array.isArray(items) || !items.length) {
    return DEFAULT_CASE_STUDIES
  }

  return items.map((item, index) => ({
    id: item.id || `case-${index + 1}`,
    title: item.title || `优秀案例 ${index + 1}`,
    subtitle: item.subtitle || '',
    spaceType: item.spaceType || '',
    targetUsers: item.targetUsers || '',
    budgetRange: item.budgetRange || '',
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : [],
    highlight: item.highlight || '',
    summary: item.summary || '',
    coverImageUrl: item.coverImageUrl || '',
    coverPreviewImageUrl: item.coverPreviewImageUrl || '',
    beforeImageUrl: item.beforeImageUrl || '',
    coreNeeds: item.coreNeeds || '',
    constraints: item.constraints || '',
    layoutSummary: item.layoutSummary || '',
  }))
}

function stripMarkdownForPreview(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/g, '')
        .replace(/^\s*[-*]\s+/g, '')
        .replace(/^\s*\d+\.\s+/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim()
    )
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildSummaryExcerpt(text, maxLength = 72) {
  const sanitized = stripMarkdownForPreview(text)

  if (!sanitized) {
    return ''
  }

  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}…` : sanitized
}

function inferFurnitureIdsFromCase(caseItem) {
  const joined = [
    caseItem && caseItem.title,
    caseItem && caseItem.subtitle,
    caseItem && caseItem.highlight,
    caseItem && caseItem.summary,
    ...(Array.isArray(caseItem && caseItem.tags) ? caseItem.tags : []),
  ]
    .filter(Boolean)
    .join(' ')

  const matchedIds = FURNITURE_OPTIONS.filter((item) => joined.indexOf(item.label) >= 0).map(
    (item) => item.id
  )

  return matchedIds.length ? matchedIds : DEFAULT_FORM.selectedFurnitureIds.slice()
}

function createDecorItem(libraryItem, count) {
  const baseWidth = Number(libraryItem.defaultWidth) > 0 ? Number(libraryItem.defaultWidth) : 156
  const baseHeight = Number(libraryItem.defaultHeight) > 0 ? Number(libraryItem.defaultHeight) : 72
  const scale = Number(libraryItem.defaultScale) > 0 ? Number(libraryItem.defaultScale) : 1

  return {
    instanceId: `${libraryItem.id}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    libraryId: libraryItem.id,
    label: libraryItem.label,
    category: libraryItem.category,
    icon: libraryItem.icon,
    color: libraryItem.color,
    accentColor: libraryItem.accentColor,
    promptHint: libraryItem.promptHint || '',
    baseWidth,
    baseHeight,
    width: Number((baseWidth * scale).toFixed(2)),
    height: Number((baseHeight * scale).toFixed(2)),
    scale,
    x: 16 + ((count || 0) % 3) * 56,
    y: 20 + Math.floor((count || 0) / 3) * 54,
  }
}

function decorateItemsForPrompt(items, sceneLabel) {
  return (items || []).map((item) => ({
    label: item.label,
    category: item.category,
    sceneLabel,
    xPercent: Math.round(Number(item.x) || 0),
    yPercent: Math.round(Number(item.y) || 0),
    scale: Number(item.scale || 1).toFixed(2),
    promptHint: item.promptHint || '',
  }))
}

function mapPositionBand(value, bands, fallback) {
  for (let i = 0; i < bands.length; i += 1) {
    if (value < bands[i].max) {
      return bands[i].label
    }
  }

  return fallback
}

function buildDecorPlacementSummary(item) {
  const centerX = Number(item.x || 0) + Number(item.width || 0) / 2
  const centerY = Number(item.y || 0) + Number(item.height || 0) / 2
  const xRatio = Math.max(0, Math.min(1, centerX / EDITOR_AREA_WIDTH_RPX))
  const yRatio = Math.max(0, Math.min(1, centerY / EDITOR_AREA_HEIGHT_RPX))
  const horizontal = mapPositionBand(
    xRatio,
    [
      { max: 0.33, label: '靠左' },
      { max: 0.66, label: '中间' },
    ],
    '靠右'
  )
  const vertical = mapPositionBand(
    yRatio,
    [
      { max: 0.33, label: '靠上' },
      { max: 0.66, label: '中部' },
    ],
    '靠下'
  )

  return {
    zoneText: `${vertical}${horizontal}`,
    xPercent: Math.round(xRatio * 100),
    yPercent: Math.round(yRatio * 100),
  }
}

function buildControlledEditPrompt({ form, sceneLabel, items }) {
  const placements = (items || []).map((item, index) => {
    const placement = buildDecorPlacementSummary(item)

    return [
      `${index + 1}. 家具：${item.label}`,
      `目标区域：${placement.zoneText}`,
      `目标坐标：横向约 ${placement.xPercent}% ，纵向约 ${placement.yPercent}%`,
      `缩放：${Number(item.scale || 1).toFixed(2)}`,
      item.promptHint ? `用途：${item.promptHint}` : '',
    ]
      .filter(Boolean)
      .join('；')
  })

  return [
    `你是一位擅长基层休息空间改造的室内设计师，请对这张${sceneLabel}进行局部增量编辑。`,
    `服务人群：${getEffectiveServicePeople(form) || '基层劳动者'}`,
    `空间类型：${getEffectiveSpaceType(form) || '基层休息空间'}`,
    `预算范围：${getEffectiveBudgetRange(form) || '未填写'}`,
    `核心诉求：${form.coreNeeds || '补充休息与收纳设施'}`,
    `约束条件：${form.constraints || '低成本、易维护、尽量不改结构'}`,
    '',
    '编辑目标：',
    '- 尽量保持原图已有布局、原有家具、墙体、门窗、视角、色调和空间结构不变。',
    '- 只在用户指定的位置新增或合理补入家具，不要大幅重排原有方案。',
    '- 如果指定位置略有冲突，可以在非常小的范围内微调，但必须尽量贴近用户指定位置。',
    sceneLabel === '2D 布局图'
      ? '- 输出仍然要保持为清晰的 2D 平面布局图风格，新增家具要与原平面图风格一致。'
      : '- 输出仍然要保持为真实感 3D 效果图风格，新增家具要与原空间透视和光线一致。',
    '- 不要凭空扩大空间，不要大改动线，不要删除原有功能区。',
    '- 若画面里出现文字标注，必须使用简体中文。',
    '',
    '坐标说明：横向百分比从画面最左侧 0% 计算到最右侧 100%；纵向百分比从画面顶部 0% 计算到底部 100%。',
    '',
    '用户拖拽指定的新增家具位置：',
    placements.join('\n') || '无',
  ].join('\n')
}

function buildShareTitle(form) {
  const servicePeople = getDisplayLabel(form.servicePeople, form.servicePeopleCustom) || '基层劳动者'
  const spaceType = getDisplayLabel(form.spaceType, form.spaceTypeCustom) || '休息空间'
  return `${servicePeople}${spaceType}改造方案`
}

function createPlanRecordId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

Page({
  data: {
    servicePeopleOptions: SERVICE_PEOPLE_OPTIONS,
    spaceTypeOptions: SPACE_TYPE_OPTIONS,
    budgetRangeOptions: BUDGET_RANGE_OPTIONS,
    budgetPickerIndex: indexOfBudgetOption(DEFAULT_FORM.budgetRange),
    furnitureOptions: buildFurnitureOptions(DEFAULT_FORM.selectedFurnitureIds),
    furnitureLibrary: DEFAULT_FURNITURE_LIBRARY,
    furnitureStyleGroups: [],
    selectedStyleSummaries: [],
    styleSelectorVisible: false,
    activeFurnitureStyleType: '',
    activeFurnitureStyleLabel: '',
    activeFurnitureStyleOptions: [],
    caseStudies: DEFAULT_CASE_STUDIES,
    form: {
      ...DEFAULT_FORM,
    },
    generating: false,
    currentStepText: '',
    errorMessage: '',
    floorPlanImagePath: '',
    floorPlanImageUrl: '',
    floorPlanImageId: '',
    renderImagePath: '',
    renderImageUrl: '',
    renderImageId: '',
    renderViews: [],
    designText: '',
    designBlocks: [],
    floorPlanPrompt: '',
    renderPrompt: '',
    designPrompt: '',
    logs: [],
    progressPercent: 0,
    progressTitle: '',
    progressHint: '',
    progressEtaText: '',
    promptCollapsed: true,
    logsCollapsed: true,
    activeWorkbenchScene: 'floor',
    floorPlanDecorItems: [],
    renderDecorItems: [],
    selectedDecorItemId: '',
    finalDesignText: '',
    finalDesignBlocks: [],
    finalDesignPrompt: '',
    finalSummaryLoading: false,
    controlledEditLoading: false,
    controlledEditPrompt: '',
    pdfExportLoading: false,
    latestPlanRecord: null,
    planFormVisible: false,
    advancedPanelVisible: false,
    currentPlanRecordId: '',
    themeName: DEFAULT_THEME,
    themeClass: THEME_CONFIG[DEFAULT_THEME].className,
    themeLabel: THEME_CONFIG[DEFAULT_THEME].label,
    themeToggleText: THEME_CONFIG[DEFAULT_THEME].toggleText,
    themeNavColor: THEME_CONFIG[DEFAULT_THEME].navColor,
    themeNavBackground: THEME_CONFIG[DEFAULT_THEME].navBackground,
    themeAccentColor: THEME_CONFIG[DEFAULT_THEME].accentColor,
  },

  onLoad() {
    if (typeof wx.showShareMenu === 'function') {
      wx.showShareMenu({
        menus: ['shareAppMessage', 'shareTimeline'],
      })
    }
    this.restoreFormCache()
    this.loadShowcaseData()
    this.loadFurnitureLibrary()
    this.loadFurnitureStyleLibrary()
    this.refreshLatestPlanRecord()
    this.resumeActiveTask()
    this.restoreTheme()
  },

  onShow() {
    this.refreshLatestPlanRecord()
    this.applyPendingCasePresetIfNeeded()
    this.resumeActiveTask()
  },

  onHide() {
    this.stopTaskPolling()
  },

  onUnload() {
    this.stopFakeProgress(false)
    this.stopTaskPolling()
  },

  restoreTheme() {
    let savedTheme = DEFAULT_THEME

    try {
      savedTheme = wx.getStorageSync(THEME_STORAGE_KEY) || DEFAULT_THEME
    } catch (error) {
      savedTheme = DEFAULT_THEME
    }

    this.applyTheme(savedTheme, false)
  },

  applyTheme(themeName, shouldPersist = true) {
    const theme = getThemeConfig(themeName)

    this.setData({
      themeName: theme.name,
      themeClass: theme.className,
      themeLabel: theme.label,
      themeToggleText: theme.toggleText,
      themeNavColor: theme.navColor,
      themeNavBackground: theme.navBackground,
      themeAccentColor: theme.accentColor,
    })

    if (!shouldPersist) {
      return
    }

    try {
      wx.setStorageSync(THEME_STORAGE_KEY, theme.name)
    } catch (error) {
      console.warn('[微光空间] save theme failed', error)
    }
  },

  toggleTheme() {
    const nextTheme = this.data.themeName === THEME_YELLOW ? THEME_BLUE : THEME_YELLOW
    this.applyTheme(nextTheme)
  },

  async refreshLatestPlanRecord() {
    const record = loadCurrentPlanRecord()

    if (record) {
      record.summaryExcerpt = buildSummaryExcerpt(record.finalDesignText || record.designText || '')
    }

    this.setData({
      latestPlanRecord: record,
      currentPlanRecordId: (record && record.id) || this.data.currentPlanRecordId,
    })

    if (record) {
      await this.restorePlanRecordOutputs(record)
    }
  },

  async restorePlanRecordOutputs(record) {
    if (!record || this.data.generating) {
      return
    }

    const hasVisibleResult =
      this.data.floorPlanImageUrl ||
      this.data.renderImageUrl ||
      (Array.isArray(this.data.renderViews) && this.data.renderViews.length) ||
      this.data.designText ||
      this.data.finalDesignText

    if (hasVisibleResult) {
      return
    }

    const nextData = {
      currentPlanRecordId: record.id || this.data.currentPlanRecordId,
      floorPlanImageUrl: record.floorPlanImageUrl || '',
      floorPlanImageId: record.floorPlanImageId || '',
      renderImageUrl: record.renderImageUrl || '',
      renderImageId: record.renderImageId || '',
      designText: record.designText || '',
      designBlocks: markdownToBlocks(record.designText || ''),
      finalDesignText: record.finalDesignText || '',
      finalDesignBlocks: markdownToBlocks(record.finalDesignText || ''),
      finalDesignPrompt: record.finalDesignPrompt || '',
    }

    if (record.floorPlanImagePath || record.floorPlanImageUrl) {
      nextData.floorPlanImagePath =
        record.floorPlanImagePath ||
        (await downloadImageForDisplay(record.floorPlanImageUrl).catch(() => record.floorPlanImageUrl))
    }

    if ((Array.isArray(record.renderViews) && record.renderViews.length) || record.renderImageUrl) {
      Object.assign(
        nextData,
        await this.applyRenderViewsResult(record.renderViews, {
          renderImageUrl: record.renderImageUrl || '',
          renderImageId: record.renderImageId || '',
          renderImagePath:
            record.renderImagePath ||
            (record.renderImageUrl
              ? await downloadImageForDisplay(record.renderImageUrl).catch(() => record.renderImageUrl)
              : ''),
        })
      )
    }

    if (
      nextData.floorPlanImageUrl ||
      nextData.renderImageUrl ||
      nextData.designText ||
      nextData.finalDesignText
    ) {
      nextData.advancedPanelVisible = true
      nextData.planFormVisible = true

      if (nextData.renderImageUrl && !nextData.floorPlanImageUrl) {
        nextData.activeWorkbenchScene = 'render'
      }
    }

    this.setData(nextData)
  },

  applyPendingCasePresetIfNeeded() {
    const pendingCase = consumePendingCasePreset()

    if (pendingCase) {
      this.applyCasePresetByItem(pendingCase)
      this.setData({
        planFormVisible: true,
      })
    }
  },

  goToCasesPage() {
    wx.redirectTo({
      url: '/pages/cases/index',
    })
  },

  goToHistoryPage() {
    wx.redirectTo({
      url: '/pages/history/index',
    })
  },

  openLatestPlanDetail() {
    const record = this.data.latestPlanRecord

    if (!record || !record.id) {
      return
    }

    wx.navigateTo({
      url: `/pages/plan-detail/index?id=${encodeURIComponent(record.id)}`,
    })
  },

  toggleAdvancedPanel() {
    this.setData({
      advancedPanelVisible: !this.data.advancedPanelVisible,
    })
  },

  openPlanForm() {
    this.setData({
      planFormVisible: true,
    })
  },

  onShareAppMessage() {
    return {
      title: buildShareTitle(this.data.form),
      path: '/pages/index/index',
      imageUrl:
        this.data.renderImageUrl ||
        ((this.data.renderViews[0] && this.data.renderViews[0].imageUrl) || '') ||
        this.data.floorPlanImageUrl ||
        '',
    }
  },

  onShareTimeline() {
    return {
      title: buildShareTitle(this.data.form),
      query: '',
      imageUrl:
        this.data.renderImageUrl ||
        ((this.data.renderViews[0] && this.data.renderViews[0].imageUrl) || '') ||
        this.data.floorPlanImageUrl ||
        '',
    }
  },

  restoreFormCache() {
    try {
      const cachedForm = wx.getStorageSync(STORAGE_KEY)

      if (!cachedForm || typeof cachedForm !== 'object') {
        return
      }

      const mergedForm = {
        ...DEFAULT_FORM,
        ...cachedForm,
      }

      mergedForm.imageModel = normalizeImageModel(mergedForm.imageModel)
      mergedForm.textModel = normalizeTextModel(mergedForm.textModel)
      mergedForm.baseUrl = normalizeCachedBaseUrl(mergedForm.baseUrl)

      if (
        typeof mergedForm.photoPath === 'string' &&
        mergedForm.photoPath &&
        (!mergedForm.photoPaths || !mergedForm.photoPaths.length)
      ) {
        mergedForm.photoPaths = [mergedForm.photoPath]
      }

      delete mergedForm.photoPath

      if (!mergedForm.budgetRange) {
        mergedForm.budgetRange = DEFAULT_FORM.budgetRange
      }

      if (typeof mergedForm.servicePeopleCustom !== 'string') {
        mergedForm.servicePeopleCustom = ''
      }

      if (typeof mergedForm.spaceTypeCustom !== 'string') {
        mergedForm.spaceTypeCustom = ''
      }

      if (typeof mergedForm.budgetRangeCustom !== 'string') {
        mergedForm.budgetRangeCustom = ''
      }

      if (!Array.isArray(mergedForm.selectedFurnitureIds)) {
        mergedForm.selectedFurnitureIds = DEFAULT_FORM.selectedFurnitureIds.slice()
      }

      if (!Array.isArray(mergedForm.selectedFurnitureStyleIds)) {
        mergedForm.selectedFurnitureStyleIds = []
      }

      if (!mergedForm.customFurnitureStylePaths || typeof mergedForm.customFurnitureStylePaths !== 'object') {
        mergedForm.customFurnitureStylePaths = {}
      }

      if (typeof mergedForm.furnitureStyleText !== 'string') {
        mergedForm.furnitureStyleText = ''
      }

      if (!Array.isArray(mergedForm.photoPaths)) {
        mergedForm.photoPaths = []
      }

      mergedForm.primaryViewIndex = clampPrimaryViewIndex(
        mergedForm.photoPaths,
        mergedForm.primaryViewIndex
      )

      this.setData({
        form: mergedForm,
        budgetPickerIndex: indexOfBudgetOption(mergedForm.budgetRange),
        furnitureOptions: buildFurnitureOptions(mergedForm.selectedFurnitureIds || []),
        selectedStyleSummaries: buildFurnitureStyleSummaries(
          mergedForm,
          this.data.furnitureStyleGroups || []
        ),
      })
    } catch (error) {
      this.appendLog('读取本地配置失败，已回退默认值。')
      console.error('[微光空间] restoreFormCache failed', error)
    }
  },

  persistFormCache(nextForm) {
    try {
      wx.setStorageSync(STORAGE_KEY, nextForm)
    } catch (error) {
      this.appendLog('保存本地配置失败，请稍后重试。')
      console.error('[微光空间] persistFormCache failed', error)
    }
  },

  appendLog(message) {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const nextLogs = [`${timestamp} ${message}`].concat(this.data.logs).slice(0, 8)

    this.setData({
      logs: nextLogs,
    })

    console.info(`[微光空间] ${message}`)
  },

  noop() {},

  async loadShowcaseData() {
    try {
      const response = await requestBackendGet({
        baseUrl: this.data.form.baseUrl,
        path: '/api/library/cases',
        timeout: 30000,
      })

      this.setData({
        caseStudies: normalizeCaseStudies(response.items),
      })
    } catch (error) {
      console.error('[微光空间] loadShowcaseData failed', error)
      this.appendLog('案例库读取失败，已展示本地示例。')
      this.setData({
        caseStudies: DEFAULT_CASE_STUDIES,
      })
    }
  },

  async loadFurnitureLibrary() {
    try {
      const response = await requestBackendGet({
        baseUrl: this.data.form.baseUrl,
        path: '/api/library/furniture',
        timeout: 30000,
      })

      this.setData({
        furnitureLibrary: normalizeFurnitureLibraryItems(response.items),
      })
    } catch (error) {
      console.error('[微光空间] loadFurnitureLibrary failed', error)
      this.appendLog('家居库读取失败，已使用本地简版素材。')
      this.setData({
        furnitureLibrary: DEFAULT_FURNITURE_LIBRARY,
      })
    }
  },

  async loadFurnitureStyleLibrary() {
    try {
      const response = await requestBackendGet({
        baseUrl: this.data.form.baseUrl,
        path: '/api/library/furniture-styles',
        timeout: 30000,
      })
      const furnitureStyleGroups = normalizeFurnitureStyleGroups(response.groups)
      const furnitureStyleText = buildFurnitureStyleText(this.data.form, furnitureStyleGroups)
      const nextForm = {
        ...this.data.form,
        furnitureStyleText,
      }

      this.setData({
        form: nextForm,
        furnitureStyleGroups,
        selectedStyleSummaries: buildFurnitureStyleSummaries(nextForm, furnitureStyleGroups),
      })
      this.persistFormCache(nextForm)
      this.hydrateFurnitureStyleDisplayImages(furnitureStyleGroups)
    } catch (error) {
      console.error('[微光空间] loadFurnitureStyleLibrary failed', error)
      this.appendLog('家具款式库读取失败，可继续使用自定义上传款式图。')
      this.setData({
        furnitureStyleGroups: [],
        selectedStyleSummaries: buildFurnitureStyleSummaries(this.data.form, []),
      })
    }
  },

  async hydrateFurnitureStyleDisplayImages(groups) {
    const hydrationId = Date.now()
    this._furnitureStyleHydrationId = hydrationId

    try {
      const furnitureStyleGroups = await hydrateFurnitureStyleGroupsForDisplay(groups)

      if (this._furnitureStyleHydrationId !== hydrationId) {
        return
      }

      const activeFurnitureStyleType = this.data.activeFurnitureStyleType
      const activeGroup = getFurnitureStyleGroup(furnitureStyleGroups, activeFurnitureStyleType)
      const selectedStyleIds = this.data.form.selectedFurnitureStyleIds || []
      const nextData = {
        furnitureStyleGroups,
        selectedStyleSummaries: buildFurnitureStyleSummaries(this.data.form, furnitureStyleGroups),
      }

      if (this.data.styleSelectorVisible && activeGroup && activeGroup.styles) {
        nextData.activeFurnitureStyleOptions = activeGroup.styles.map((item) => ({
          ...item,
          selected: selectedStyleIds.indexOf(item.id) >= 0,
        }))
      }

      this.setData(nextData)
    } catch (error) {
      console.warn('[微光空间] hydrateFurnitureStyleDisplayImages failed', error)
    }
  },

  startFakeProgress() {
    this.stopFakeProgress(false)

    const startedAt = Date.now()
    const firstStage = FAKE_PROGRESS_STAGES[0]

    this.setData({
      progressPercent: 3,
      progressTitle: firstStage.title,
      progressHint: firstStage.hint,
      progressEtaText: this.buildProgressEtaText({}),
    })

    this._progressTimer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt
      let currentStage = FAKE_PROGRESS_STAGES[0]

      FAKE_PROGRESS_STAGES.forEach((stage) => {
        if (elapsedMs >= stage.minElapsedMs) {
          currentStage = stage
        }
      })

      const currentPercent = this.data.progressPercent || 0
      const increment = currentPercent < 30 ? 3 : currentPercent < 65 ? 2 : 1
      const nextPercent = Math.min(
        currentStage.maxPercent,
        currentPercent + increment
      )

      this.setData({
        progressPercent: nextPercent,
        progressTitle: currentStage.title,
        progressHint: currentStage.hint,
        progressEtaText: this.buildProgressEtaText({}),
      })
    }, 1200)
  },

  stopFakeProgress(markCompleted = true) {
    if (this._progressTimer) {
      clearInterval(this._progressTimer)
      this._progressTimer = null
    }

    if (markCompleted) {
      this.setData({
        progressPercent: 100,
        progressTitle: '方案生成完成',
        progressHint: '可以查看布局图、效果图和中文设计说明了',
        progressEtaText: '',
      })
      return
    }

    this.setData({
      progressPercent: 0,
      progressTitle: '',
      progressHint: '',
      progressEtaText: '',
    })
  },

  saveActiveTask(taskInfo) {
    try {
      wx.setStorageSync(ACTIVE_TASK_STORAGE_KEY, taskInfo)
    } catch (error) {
      console.error('[微光空间] saveActiveTask failed', error)
    }
  },

  clearActiveTask() {
    try {
      wx.removeStorageSync(ACTIVE_TASK_STORAGE_KEY)
    } catch (error) {
      console.error('[微光空间] clearActiveTask failed', error)
    }
  },

  stopTaskPolling() {
    if (this._taskPollingTimer) {
      clearInterval(this._taskPollingTimer)
      this._taskPollingTimer = null
    }
  },

  async resumeActiveTask() {
    try {
      const taskInfo = wx.getStorageSync(ACTIVE_TASK_STORAGE_KEY)

      if (!taskInfo || !taskInfo.taskId || !taskInfo.baseUrl) {
        return
      }

      await this.fetchTaskStatus(taskInfo.taskId, taskInfo.baseUrl, false)

      const latestTaskInfo = wx.getStorageSync(ACTIVE_TASK_STORAGE_KEY)
      if (latestTaskInfo && latestTaskInfo.taskId) {
        this.startTaskPolling(latestTaskInfo.taskId, latestTaskInfo.baseUrl)
      }
    } catch (error) {
      console.error('[微光空间] resumeActiveTask failed', error)
    }
  },

  startTaskPolling(taskId, baseUrl) {
    this.stopTaskPolling()
    this._taskPollingTimer = setInterval(() => {
      this.fetchTaskStatus(taskId, baseUrl, true).catch((error) => {
        console.error('[微光空间] task polling failed', error)
      })
    }, 2500)
  },

  getRenderViewSignature(renderViews, renderImageUrl) {
    const items = Array.isArray(renderViews) ? renderViews : []
    return items
      .map((item) => {
        const imageId = String((item && (item.imageId || item.renderImageId)) || '').trim()
        const imageUrl = String((item && (item.imageUrl || item.renderImageUrl)) || '').trim()
        const sourceIndex = Number.isFinite(Number(item && item.sourceIndex))
          ? Number(item.sourceIndex)
          : 0
        return `${sourceIndex}:${imageId || imageUrl}`
      })
      .concat(items.length ? [] : [String(renderImageUrl || '').trim()])
      .filter(Boolean)
      .join('|')
  },

  hasRenderableImagePath(renderViews) {
    return (Array.isArray(renderViews) ? renderViews : []).some((item) => item && item.imagePath)
  },

  shouldApplyRenderTaskResult(taskResult) {
    const incomingViews = Array.isArray(taskResult.renderViews) ? taskResult.renderViews : []
    const hasIncomingRender = incomingViews.length || taskResult.renderImageUrl

    if (!hasIncomingRender) {
      return false
    }

    const incomingSignature = this.getRenderViewSignature(incomingViews, taskResult.renderImageUrl)
    const currentSignature = this.getRenderViewSignature(this.data.renderViews, this.data.renderImageUrl)

    return (
      incomingSignature !== currentSignature ||
      !this.data.renderImagePath ||
      !this.hasRenderableImagePath(this.data.renderViews)
    )
  },

  resolveCachedRenderImagePath(imageId, imageUrl) {
    const currentViews = Array.isArray(this.data.renderViews) ? this.data.renderViews : []
    const matchedView = currentViews.find((item) => {
      if (!item || !item.imagePath) {
        return false
      }

      return (
        (imageId && item.imageId === imageId) ||
        (imageUrl && item.imageUrl === imageUrl)
      )
    })

    if (matchedView && matchedView.imagePath) {
      return matchedView.imagePath
    }

    if (
      this.data.renderImagePath &&
      ((imageId && this.data.renderImageId === imageId) ||
        (imageUrl && this.data.renderImageUrl === imageUrl))
    ) {
      return this.data.renderImagePath
    }

    return ''
  },

  async buildRenderViewsForDisplay(renderViews) {
    const list = Array.isArray(renderViews) ? renderViews : []
    const nextViews = []

    for (let i = 0; i < list.length; i += 1) {
      const item = list[i]
      if (!item || typeof item !== 'object') {
        continue
      }

      const imageUrl = String(item.imageUrl || item.renderImageUrl || '').trim()
      const imageId = String(item.imageId || item.renderImageId || '').trim()
      const sourceIndex = Number.isFinite(Number(item.sourceIndex)) ? Number(item.sourceIndex) : i

      if (!imageUrl && !imageId) {
        continue
      }

      const cachedImagePath = this.resolveCachedRenderImagePath(imageId, imageUrl)
      const imagePath =
        cachedImagePath || (imageUrl ? await downloadImageForDisplay(imageUrl).catch(() => imageUrl) : '')

      nextViews.push({
        sourceIndex,
        title: String(
          item.title || buildRenderViewTitle(sourceIndex, list.length || 1, Boolean(item.isPrimary))
        ),
        imageId,
        imageUrl,
        imagePath,
        isPrimary: Boolean(item.isPrimary),
      })
    }

    if (!nextViews.some((item) => item.isPrimary) && nextViews.length) {
      nextViews[0].isPrimary = true
    }

    return nextViews.sort((a, b) => a.sourceIndex - b.sourceIndex)
  },

  async applyRenderViewsResult(renderViews, fallbackRender) {
    const resolvedViews = await this.buildRenderViewsForDisplay(renderViews)

    if (resolvedViews.length) {
      const primaryView = resolvedViews.find((item) => item.isPrimary) || resolvedViews[0]
      return {
        renderViews: resolvedViews,
        renderImagePath: primaryView.imagePath || '',
        renderImageUrl: primaryView.imageUrl || '',
        renderImageId: primaryView.imageId || '',
      }
    }

    if (fallbackRender && fallbackRender.renderImageUrl) {
      return {
        renderViews: [
          {
            sourceIndex: 0,
            title: '效果图',
            imageId: fallbackRender.renderImageId || '',
            imageUrl: fallbackRender.renderImageUrl,
            imagePath: fallbackRender.renderImagePath || '',
            isPrimary: true,
          },
        ],
        renderImagePath: fallbackRender.renderImagePath || '',
        renderImageUrl: fallbackRender.renderImageUrl || '',
        renderImageId: fallbackRender.renderImageId || '',
      }
    }

    return {}
  },

  async applyPartialTaskResult(taskResult) {
    const nextData = {}

    if (
      taskResult.floorPlanImageUrl &&
      taskResult.floorPlanImageUrl !== this.data.floorPlanImageUrl
    ) {
      nextData.floorPlanImagePath = await downloadImageForDisplay(
        taskResult.floorPlanImageUrl
      ).catch(() => taskResult.floorPlanImageUrl)
      nextData.floorPlanImageUrl = taskResult.floorPlanImageUrl
      nextData.floorPlanImageId =
        taskResult.floorPlanImageId || this.data.floorPlanImageId
    }

    if (this.shouldApplyRenderTaskResult(taskResult)) {
      Object.assign(
        nextData,
        await this.applyRenderViewsResult(taskResult.renderViews, {
          renderImagePath:
            taskResult.renderImageUrl && taskResult.renderImageUrl !== this.data.renderImageUrl
              ? await downloadImageForDisplay(taskResult.renderImageUrl).catch(() => taskResult.renderImageUrl)
              : this.data.renderImagePath,
          renderImageUrl: taskResult.renderImageUrl || this.data.renderImageUrl,
          renderImageId: taskResult.renderImageId || this.data.renderImageId,
        })
      )
    }

    if (nextData.renderImagePath || nextData.renderImageUrl) {
      nextData.advancedPanelVisible = true

      if (!this.data.floorPlanImagePath && !nextData.floorPlanImagePath) {
        nextData.activeWorkbenchScene = 'render'
      }
    }

    if (
      typeof taskResult.designText === 'string' &&
      taskResult.designText &&
      taskResult.designText !== this.data.designText
    ) {
      nextData.designText = taskResult.designText
      nextData.designBlocks = markdownToBlocks(taskResult.designText)
    }

    if (taskResult.floorPlanPrompt && !this.data.floorPlanPrompt) {
      nextData.floorPlanPrompt = taskResult.floorPlanPrompt
    }

    if (taskResult.renderPrompt && !this.data.renderPrompt) {
      nextData.renderPrompt = taskResult.renderPrompt
    }

    if (taskResult.designPrompt && !this.data.designPrompt) {
      nextData.designPrompt = taskResult.designPrompt
    }

    if (Object.keys(nextData).length > 0) {
      this.setData(nextData, () => {
        this.syncCurrentPlanSnapshot()
      })
    }
  },

  async applyCompletedTaskResult(taskResult) {
    await this.applyPartialTaskResult(taskResult)

    this.setData({
      generating: false,
      currentStepText: '完整方案生成完成',
      errorMessage: '',
      progressPercent: 100,
      progressTitle: '方案生成完成',
      progressHint: '可以查看布局图、效果图和中文设计说明了',
      progressEtaText: '',
    })
    this.syncCurrentPlanSnapshot()
  },

  getExpectedRenderViewCount() {
    const photoCount = Array.isArray(this.data.form.photoPaths)
      ? this.data.form.photoPaths.length
      : 0

    return Math.max(1, photoCount)
  },

  buildProgressEtaText(result = {}) {
    const renderViews = Array.isArray(result.renderViews) ? result.renderViews : []
    const hasRender = Boolean(result.renderImageUrl) || renderViews.length > 0
    const hasFloor = Boolean(result.floorPlanImageUrl)
    const hasDesign = Boolean(result.designText)
    const expectedRenderCount = this.getExpectedRenderViewCount()
    const completedRenderCount = Math.max(
      renderViews.length,
      result.renderImageUrl ? 1 : 0
    )

    if (hasDesign) {
      return '预估等待：图片和说明已完成，正在保存方案。'
    }

    if (hasFloor) {
      return '预估等待：3D 和 2D 已完成；设计说明通常还需不到 1 分钟。'
    }

    if (hasRender) {
      if (expectedRenderCount > 1 && completedRenderCount < expectedRenderCount) {
        return `预估等待：已生成 ${completedRenderCount}/${expectedRenderCount} 张 3D；剩余 3D 每张约 ${ESTIMATED_RENDER_MINUTES.min}-${ESTIMATED_RENDER_MINUTES.max} 分钟，2D 约 ${ESTIMATED_FLOOR_MINUTES.min}-${ESTIMATED_FLOOR_MINUTES.max} 分钟。`
      }

      return `预估等待：3D 已完成；2D 图纸约 ${ESTIMATED_FLOOR_MINUTES.min}-${ESTIMATED_FLOOR_MINUTES.max} 分钟，设计说明通常不到 1 分钟。`
    }

    if (expectedRenderCount > 1) {
      const totalMin =
        expectedRenderCount * ESTIMATED_RENDER_MINUTES.min +
        ESTIMATED_FLOOR_MINUTES.min +
        ESTIMATED_DESIGN_MINUTES.max
      const totalMax =
        expectedRenderCount * ESTIMATED_RENDER_MINUTES.max +
        ESTIMATED_FLOOR_MINUTES.max +
        ESTIMATED_DESIGN_MINUTES.max

      return `预估等待：3D 每张约 ${ESTIMATED_RENDER_MINUTES.min}-${ESTIMATED_RENDER_MINUTES.max} 分钟，共 ${expectedRenderCount} 张；2D 约 ${ESTIMATED_FLOOR_MINUTES.min}-${ESTIMATED_FLOOR_MINUTES.max} 分钟；完整方案约 ${totalMin}-${totalMax} 分钟。`
    }

    return `预估等待：3D 首图约 ${ESTIMATED_RENDER_MINUTES.min}-${ESTIMATED_RENDER_MINUTES.max} 分钟；2D 约 ${ESTIMATED_FLOOR_MINUTES.min}-${ESTIMATED_FLOOR_MINUTES.max} 分钟；完整方案约 6-8 分钟。`
  },

  buildTaskProgressDisplay(taskResponse) {
    const serverPercent = Number(taskResponse && taskResponse.progressPercent) || 0
    const result = (taskResponse && taskResponse.result) || {}
    const hasRender =
      Boolean(result.renderImageUrl) ||
      (Array.isArray(result.renderViews) && result.renderViews.length > 0)
    const hasFloor = Boolean(result.floorPlanImageUrl)
    const isWaitingForFloor =
      taskResponse &&
      taskResponse.status === 'running' &&
      hasRender &&
      !hasFloor &&
      serverPercent >= 68 &&
      serverPercent < 86

    if (!isWaitingForFloor) {
      return {
        progressPercent: serverPercent,
        progressTitle: (taskResponse && taskResponse.progressTitle) || '',
        progressHint: (taskResponse && taskResponse.progressHint) || '',
        progressEtaText: this.buildProgressEtaText(result),
      }
    }

    const currentPercent = Number(this.data.progressPercent) || 0
    const progressPercent = Math.min(84, Math.max(serverPercent, currentPercent + 1))

    return {
      progressPercent,
      progressTitle: '3D 效果图已显示，正在生成 2D 图纸',
      progressHint: '你可以先查看 3D 效果图；2D 图纸仍在生成中，完成后会自动补上',
      progressEtaText: this.buildProgressEtaText(result),
    }
  },

  async fetchTaskStatus(taskId, baseUrl, silent) {
    const taskResponse = await requestBackendGet({
      baseUrl,
      path: `/api/tasks/${encodeURIComponent(taskId)}`,
      timeout: 30000,
    })
    const progressDisplay = this.buildTaskProgressDisplay(taskResponse)

    this.setData({
      generating: taskResponse.status === 'queued' || taskResponse.status === 'running',
      currentStepText: progressDisplay.progressTitle || '',
      progressPercent: progressDisplay.progressPercent,
      progressTitle: progressDisplay.progressTitle,
      progressHint: progressDisplay.progressHint,
      progressEtaText: progressDisplay.progressEtaText || '',
    })

    if (taskResponse.result) {
      await this.applyPartialTaskResult(taskResponse.result)
    }

    if (taskResponse.status === 'queued' || taskResponse.status === 'running') {
      this.saveActiveTask({ taskId, baseUrl })
      return taskResponse
    }

    this.stopTaskPolling()
    this.clearActiveTask()

    if (taskResponse.status === 'completed' && taskResponse.result) {
      await this.applyCompletedTaskResult(taskResponse.result)
      if (!silent) {
        this.appendLog('已恢复已完成任务结果。')
      }
      return taskResponse
    }

    if (taskResponse.status === 'failed') {
      this.setData({
        generating: false,
        errorMessage: taskResponse.error || '任务执行失败，请重试。',
        progressEtaText: '',
      })
      if (!silent) {
        this.appendLog(`任务失败：${taskResponse.error || '未知错误'}`)
      }
    }

    return taskResponse
  },

  updateFormField(field, value) {
    const nextForm = {
      ...this.data.form,
      [field]: value,
    }

    this.setData({
      form: nextForm,
    })
    this.persistFormCache(nextForm)
  },

  onTextInput(event) {
    const field = event.currentTarget.dataset.field
    const value = event.detail.value

    if (field === 'servicePeopleCustom') {
      const nextForm = {
        ...this.data.form,
        servicePeopleCustom: value,
        servicePeople: String(value || '').trim() ? SERVICE_PEOPLE_OTHER : this.data.form.servicePeople,
      }

      this.setData({
        form: nextForm,
      })
      this.persistFormCache(nextForm)
      return
    }

    this.updateFormField(field, value)
  },

  onServicePeopleChange(event) {
    const index = Number(event.detail.value || 0)
    const value = this.data.servicePeopleOptions[index] || ''
    const nextForm = {
      ...this.data.form,
      servicePeople: value,
      servicePeopleCustom: '',
    }

    this.setData({
      form: nextForm,
    })
    this.persistFormCache(nextForm)
  },

  updatePhotoPaths(nextPhotoPaths, preferredPrimaryIndex) {
    const photoPaths = Array.isArray(nextPhotoPaths) ? nextPhotoPaths : []
    const nextForm = {
      ...this.data.form,
      photoPaths,
      primaryViewIndex: clampPrimaryViewIndex(photoPaths, preferredPrimaryIndex),
    }

    this.setData({
      form: nextForm,
    })
    this.persistFormCache(nextForm)
  },

  onSpaceTypeChange(event) {
    const index = Number(event.detail.value || 0)
    const value = this.data.spaceTypeOptions[index] || ''
    const nextForm = {
      ...this.data.form,
      spaceType: value,
      spaceTypeCustom: '',
    }

    this.setData({
      form: nextForm,
    })
    this.persistFormCache(nextForm)
  },

  onBudgetRangeChange(event) {
    const index = Number(event.detail.value || 0)
    const value = this.data.budgetRangeOptions[index] || ''
    const nextForm = {
      ...this.data.form,
      budgetRange: value,
      budgetRangeCustom: '',
    }

    this.setData({
      form: nextForm,
      budgetPickerIndex: index,
    })
    this.persistFormCache(nextForm)
  },

  async buildImageUploadFormData(extraFields, options = {}) {
    const { form } = this.data
    const payload = {
      servicePeople: getEffectiveServicePeople(form),
      spaceType: getEffectiveSpaceType(form),
      areaText: form.areaText,
      budgetRange: getEffectiveBudgetRange(form),
      coreNeeds: form.coreNeeds,
      constraints: form.constraints,
      selectedFurnitureIds: form.selectedFurnitureIds,
      selectedFurnitureStyleIds: form.selectedFurnitureStyleIds || [],
      furnitureStyleText: form.furnitureStyleText || '',
      ...(extraFields || {}),
    }
    const extraJson = await buildExtraImagesJsonForUpload(
      Array.isArray(options.photoPaths)
        ? options.photoPaths
        : [].concat(form.photoPaths || []).slice(1)
    )

    if (extraJson) {
      payload.extraImagesJson = extraJson
    }

    const furnitureReferenceImagesJson = await buildFurnitureReferenceImagesJsonForUpload(
      form.customFurnitureStylePaths || {}
    )

    if (furnitureReferenceImagesJson) {
      payload.furnitureReferenceImagesJson = furnitureReferenceImagesJson
    }

    return payload
  },

  onFurnitureChange(event) {
    const selectedFurnitureIds = event.detail.value || []
    const previousSelectedIds = this.data.form.selectedFurnitureIds || []
    const removedIds = previousSelectedIds.filter((id) => selectedFurnitureIds.indexOf(id) < 0)
    const addedStyleTargetId = selectedFurnitureIds.find(
      (id) => previousSelectedIds.indexOf(id) < 0 && isFurnitureStyleTarget(id)
    )
    const customFurnitureStylePaths = {
      ...(this.data.form.customFurnitureStylePaths || {}),
    }
    let selectedFurnitureStyleIds = [].concat(this.data.form.selectedFurnitureStyleIds || [])

    removedIds.forEach((id) => {
      if (!isFurnitureStyleTarget(id)) {
        return
      }

      delete customFurnitureStylePaths[id]
      selectedFurnitureStyleIds = selectedFurnitureStyleIds.filter((styleId) => {
        const styleItem = flattenFurnitureStyleGroups(this.data.furnitureStyleGroups).find(
          (item) => item.id === styleId
        )
        return !styleItem || styleItem.furnitureId !== id
      })
    })

    const nextForm = {
      ...this.data.form,
      selectedFurnitureIds,
      selectedFurnitureStyleIds,
      customFurnitureStylePaths,
    }
    nextForm.furnitureStyleText = buildFurnitureStyleText(
      nextForm,
      this.data.furnitureStyleGroups || []
    )

    this.setData({
      form: nextForm,
      furnitureOptions: buildFurnitureOptions(selectedFurnitureIds),
      selectedStyleSummaries: buildFurnitureStyleSummaries(
        nextForm,
        this.data.furnitureStyleGroups || []
      ),
    })
    this.persistFormCache(nextForm)

    if (addedStyleTargetId) {
      this.openFurnitureStyleSelectorByType(addedStyleTargetId)
    }
  },

  openFurnitureStyleSelector(event) {
    const furnitureId = event.currentTarget.dataset.id
    this.openFurnitureStyleSelectorByType(furnitureId)
  },

  openFurnitureStyleSelectorByType(furnitureId) {
    if (!isFurnitureStyleTarget(furnitureId)) {
      return
    }

    const group = getFurnitureStyleGroup(this.data.furnitureStyleGroups, furnitureId)
    const selectedStyleIds = this.data.form.selectedFurnitureStyleIds || []

    this.setData({
      styleSelectorVisible: true,
      activeFurnitureStyleType: furnitureId,
      activeFurnitureStyleLabel:
        FURNITURE_STYLE_LABEL_MAP[furnitureId] || (group && group.furnitureLabel) || '家具',
      activeFurnitureStyleOptions:
        group && group.styles
          ? group.styles.map((item) => ({
              ...item,
              selected: selectedStyleIds.indexOf(item.id) >= 0,
            }))
          : [],
    })
  },

  closeFurnitureStyleSelector() {
    this.setData({
      styleSelectorVisible: false,
      activeFurnitureStyleType: '',
      activeFurnitureStyleLabel: '',
      activeFurnitureStyleOptions: [],
    })
  },

  selectFurnitureStyle(event) {
    const styleId = event.currentTarget.dataset.id
    const furnitureId = this.data.activeFurnitureStyleType

    if (!styleId || !furnitureId) {
      return
    }

    const styleItems = flattenFurnitureStyleGroups(this.data.furnitureStyleGroups)
    const selectedStyle = styleItems.find((item) => item.id === styleId)
    const customFurnitureStylePaths = {
      ...(this.data.form.customFurnitureStylePaths || {}),
    }
    const selectedFurnitureStyleIds = [].concat(this.data.form.selectedFurnitureStyleIds || []).filter(
      (id) => {
        const styleItem = styleItems.find((item) => item.id === id)
        return !styleItem || styleItem.furnitureId !== furnitureId
      }
    )

    selectedFurnitureStyleIds.push(styleId)
    delete customFurnitureStylePaths[furnitureId]

    const nextForm = {
      ...this.data.form,
      selectedFurnitureStyleIds,
      customFurnitureStylePaths,
    }
    nextForm.furnitureStyleText = buildFurnitureStyleText(nextForm, this.data.furnitureStyleGroups)

    this.setData({
      form: nextForm,
      selectedStyleSummaries: buildFurnitureStyleSummaries(nextForm, this.data.furnitureStyleGroups),
      activeFurnitureStyleOptions: this.data.activeFurnitureStyleOptions.map((item) => ({
        ...item,
        selected: item.id === styleId,
      })),
    })
    this.persistFormCache(nextForm)
    this.appendLog(
      `${FURNITURE_STYLE_LABEL_MAP[furnitureId] || furnitureId} 已指定款式：${
        (selectedStyle && selectedStyle.label) || styleId
      }。`
    )
    wx.showToast({
      title: '已指定款式',
      icon: 'success',
    })
  },

  clearFurnitureStyleForActive() {
    const furnitureId = this.data.activeFurnitureStyleType

    if (!furnitureId) {
      return
    }

    const styleItems = flattenFurnitureStyleGroups(this.data.furnitureStyleGroups)
    const customFurnitureStylePaths = {
      ...(this.data.form.customFurnitureStylePaths || {}),
    }
    const selectedFurnitureStyleIds = [].concat(this.data.form.selectedFurnitureStyleIds || []).filter(
      (id) => {
        const styleItem = styleItems.find((item) => item.id === id)
        return !styleItem || styleItem.furnitureId !== furnitureId
      }
    )

    delete customFurnitureStylePaths[furnitureId]

    const nextForm = {
      ...this.data.form,
      selectedFurnitureStyleIds,
      customFurnitureStylePaths,
    }
    nextForm.furnitureStyleText = buildFurnitureStyleText(nextForm, this.data.furnitureStyleGroups)

    this.setData({
      form: nextForm,
      selectedStyleSummaries: buildFurnitureStyleSummaries(nextForm, this.data.furnitureStyleGroups),
      activeFurnitureStyleOptions: this.data.activeFurnitureStyleOptions.map((item) => ({
        ...item,
        selected: false,
      })),
    })
    this.persistFormCache(nextForm)
  },

  chooseCustomFurnitureStyleImage() {
    const furnitureId = this.data.activeFurnitureStyleType

    if (!furnitureId) {
      return
    }

    const applyPath = (filePath) => {
      if (!filePath) {
        return
      }

      const styleItems = flattenFurnitureStyleGroups(this.data.furnitureStyleGroups)
      const customFurnitureStylePaths = {
        ...(this.data.form.customFurnitureStylePaths || {}),
        [furnitureId]: filePath,
      }
      const selectedFurnitureStyleIds = [].concat(this.data.form.selectedFurnitureStyleIds || []).filter(
        (id) => {
          const styleItem = styleItems.find((item) => item.id === id)
          return !styleItem || styleItem.furnitureId !== furnitureId
        }
      )
      const nextForm = {
        ...this.data.form,
        selectedFurnitureStyleIds,
        customFurnitureStylePaths,
      }
      nextForm.furnitureStyleText = buildFurnitureStyleText(nextForm, this.data.furnitureStyleGroups)

      this.setData({
        form: nextForm,
        selectedStyleSummaries: buildFurnitureStyleSummaries(nextForm, this.data.furnitureStyleGroups),
        activeFurnitureStyleOptions: this.data.activeFurnitureStyleOptions.map((item) => ({
          ...item,
          selected: false,
        })),
      })
      this.persistFormCache(nextForm)
      this.appendLog(`${FURNITURE_STYLE_LABEL_MAP[furnitureId] || furnitureId} 已上传自定义款式图。`)
      wx.showToast({
        title: '已上传款式图',
        icon: 'success',
      })
    }

    if (typeof wx.chooseMedia === 'function') {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        success: (res) => {
          const file = res.tempFiles && res.tempFiles[0]
          applyPath(file && file.tempFilePath)
        },
      })
      return
    }

    wx.chooseImage({
      count: 1,
      sourceType: ['album', 'camera'],
      success: (res) => {
        applyPath(res.tempFilePaths && res.tempFilePaths[0])
      },
    })
  },

  togglePromptCollapsed() {
    this.setData({
      promptCollapsed: !this.data.promptCollapsed,
    })
  },

  toggleLogsCollapsed() {
    this.setData({
      logsCollapsed: !this.data.logsCollapsed,
    })
  },

  chooseSpacePhoto() {
    const existingPaths = [].concat(this.data.form.photoPaths || [])
    const remainingCount = MAX_SPACE_PHOTOS - existingPaths.length

    if (remainingCount <= 0) {
      wx.showToast({
        title: `最多上传 ${MAX_SPACE_PHOTOS} 张`,
        icon: 'none',
      })
      return
    }

    wx.chooseMedia({
      count: remainingCount,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const selectedTempPaths = (res.tempFiles || [])
          .map((item) => item.tempFilePath)
          .filter(Boolean)

        if (!selectedTempPaths.length) {
          return
        }

        const selectedPaths = await persistLocalPhotosForStorage(selectedTempPaths)
        const photoPaths = mergePhotoPaths(existingPaths, selectedPaths)
        this.updatePhotoPaths(photoPaths, this.data.form.primaryViewIndex)

        if (photoPaths[0] && /^http:\/\/tmp\//i.test(photoPaths[0])) {
          this.appendLog('检测到开发者工具临时路径，当前将走后端上传模式。')
        }

        this.appendLog(
          `本次新增 ${selectedPaths.length} 张，当前共 ${photoPaths.length} 张空间现状照片。`
        )
      },
      fail: (error) => {
        if (error && error.errMsg && error.errMsg.indexOf('cancel') >= 0) {
          return
        }

        this.appendLog('选择图片失败。')
        console.error('[微光空间] chooseSpacePhoto failed', error)
      },
    })
  },

  clearSpacePhoto() {
    this.updatePhotoPaths([], 0)
  },

  removePhotoAt(event) {
    const index = Number(event.currentTarget.dataset.index)
    const paths = [].concat(this.data.form.photoPaths || [])

    if (!Number.isFinite(index) || index < 0 || index >= paths.length) {
      return
    }

    paths.splice(index, 1)
    this.updatePhotoPaths(paths, index === this.data.form.primaryViewIndex ? 0 : this.data.form.primaryViewIndex)
  },

  setPrimaryViewIndex(event) {
    const index = Number(event.currentTarget.dataset.index)
    const photoPaths = [].concat(this.data.form.photoPaths || [])

    if (!photoPaths.length) {
      return
    }

    const primaryViewIndex = clampPrimaryViewIndex(photoPaths, index)
    const nextForm = {
      ...this.data.form,
      primaryViewIndex,
    }

    this.setData({
      form: nextForm,
    })
    this.persistFormCache(nextForm)
      this.appendLog(`已将第 ${primaryViewIndex + 1} 张原图设为默认展示图。`)
  },

  previewLocalPhoto(event) {
    const urls = this.data.form.photoPaths || []

    if (!urls.length) {
      return
    }

    const index = Number(event.currentTarget.dataset.index || 0)
    const current = urls[index >= 0 && index < urls.length ? index : 0]

    wx.previewImage({
      current,
      urls,
    })
  },

  previewRenderView(event) {
    const index = Number(event.currentTarget.dataset.index || 0)
    const views = Array.isArray(this.data.renderViews) ? this.data.renderViews : []
    const urls = views.map((item) => item.imagePath || item.imageUrl).filter(Boolean)

    if (!urls.length) {
      return
    }

    const current = urls[index >= 0 && index < urls.length ? index : 0]
    wx.previewImage({
      current,
      urls,
    })
  },

  previewOutputImage(event) {
    const type = event.currentTarget.dataset.type
    const imagePath = type === 'render' ? this.data.renderImagePath : this.data.floorPlanImagePath

    if (!imagePath) {
      return
    }

    wx.previewImage({
      current: imagePath,
      urls: [imagePath],
    })
  },

  onOutputImageLoad(event) {
    const type = event.currentTarget.dataset.type
    const detail = event.detail || {}
    this.appendLog(
      `${type === 'render' ? '3D 效果图' : '2D 布局图'}加载成功。width=${detail.width || 0} height=${detail.height || 0}`
    )
  },

  onOutputImageError(event) {
    const type = event.currentTarget.dataset.type
    this.appendLog(
      `${type === 'render' ? '3D 效果图' : '2D 布局图'}加载失败。detail=${JSON.stringify(event.detail || {})}`
    )
  },

  previewCaseImage(event) {
    const url = String(event.currentTarget.dataset.url || '').trim()

    if (!url) {
      return
    }

    wx.previewImage({
      current: url,
      urls: [url],
    })
  },

  openCaseDetail(event) {
    const id = String(event.currentTarget.dataset.id || '').trim()

    if (!id) {
      return
    }

    wx.navigateTo({
      url: `/pages/case-detail/index?id=${encodeURIComponent(id)}`,
    })
  },

  quickApplyCasePreset(event) {
    const id = String(event.currentTarget.dataset.id || '').trim()
    const caseItem = (this.data.caseStudies || []).find((item) => item.id === id)

    if (!caseItem) {
      return
    }

    this.applyCasePresetByItem(caseItem)
  },

  applyCasePreset(event) {
    const index = Number(event.currentTarget.dataset.index)
    const caseItem = this.data.caseStudies[index]

    if (!caseItem) {
      return
    }

    this.applyCasePresetByItem(caseItem)
  },

  applyCasePresetByItem(caseItem) {
    if (!caseItem) {
      return
    }

    const servicePreset = resolveServicePeoplePreset(caseItem.targetUsers)
    const selectedFurnitureIds = inferFurnitureIdsFromCase(caseItem)
    const budgetOptionIndex = BUDGET_RANGE_OPTIONS.indexOf(caseItem.budgetRange)
    const useCustomBudget = budgetOptionIndex < 0

    const nextForm = {
      ...this.data.form,
      servicePeople: servicePreset.servicePeople,
      servicePeopleCustom: servicePreset.servicePeopleCustom,
      spaceType: caseItem.spaceType || this.data.form.spaceType,
      spaceTypeCustom: '',
      budgetRange: useCustomBudget
        ? this.data.form.budgetRange || DEFAULT_FORM.budgetRange
        : caseItem.budgetRange || this.data.form.budgetRange,
      budgetRangeCustom: useCustomBudget ? caseItem.budgetRange || '' : '',
      coreNeeds: caseItem.coreNeeds || caseItem.highlight || this.data.form.coreNeeds,
      constraints: caseItem.constraints || caseItem.summary || this.data.form.constraints,
      selectedFurnitureIds,
    }

    this.setData({
      form: nextForm,
      budgetPickerIndex: useCustomBudget
        ? indexOfBudgetOption(this.data.form.budgetRange || DEFAULT_FORM.budgetRange)
        : budgetOptionIndex,
      furnitureOptions: buildFurnitureOptions(selectedFurnitureIds),
    })
    this.persistFormCache(nextForm)
    wx.showToast({
      title: '已套用案例需求',
      icon: 'success',
    })
    this.appendLog(`已套用案例「${caseItem.title}」的需求预设，并同步更新表单。`)
  },

  getActiveWorkbenchSceneLabel() {
    return this.data.activeWorkbenchScene === 'render' ? '3D 效果图' : '2D 布局图'
  },

  getActiveDecorItemsKey() {
    return this.data.activeWorkbenchScene === 'render' ? 'renderDecorItems' : 'floorPlanDecorItems'
  },

  getActiveDecorItems() {
    return [].concat(this.data[this.getActiveDecorItemsKey()] || [])
  },

  setActiveWorkbenchScene(scene) {
    const nextScene = scene === 'render' ? 'render' : 'floor'
    this.setData({
      activeWorkbenchScene: nextScene,
      selectedDecorItemId: '',
    })
  },

  onWorkbenchSceneChange(event) {
    this.setActiveWorkbenchScene(event.currentTarget.dataset.scene)
  },

  addFurnitureToWorkbench(event) {
    const furnitureId = String(event.currentTarget.dataset.id || '').trim()
    const libraryItem = (this.data.furnitureLibrary || []).find((item) => item.id === furnitureId)

    if (!libraryItem) {
      return
    }

    const key = this.getActiveDecorItemsKey()
    const currentItems = this.getActiveDecorItems()
    const nextItem = createDecorItem(libraryItem, currentItems.length)
    const nextItems = currentItems.concat(nextItem)

    this.setData({
      [key]: nextItems,
      selectedDecorItemId: nextItem.instanceId,
    })
    this.appendLog(`已在${this.getActiveWorkbenchSceneLabel()}添加「${libraryItem.label}」。`)
  },

  selectDecorItem(event) {
    const instanceId = String(event.currentTarget.dataset.instanceId || '').trim()

    if (!instanceId) {
      return
    }

    this.setData({
      selectedDecorItemId: instanceId,
    })
  },

  onDecorItemChange(event) {
    const instanceId = String(event.currentTarget.dataset.instanceId || '').trim()
    const key = this.getActiveDecorItemsKey()
    const currentItems = this.getActiveDecorItems()
    const nextItems = currentItems.map((item) => {
      if (item.instanceId !== instanceId) {
        return item
      }

      return {
        ...item,
        x: Number(event.detail.x || 0),
        y: Number(event.detail.y || 0),
      }
    })

    this.setData({
      [key]: nextItems,
    })
  },

  changeSelectedDecorScale(event) {
    const delta = Number(event.currentTarget.dataset.delta || 0)
    const selectedId = this.data.selectedDecorItemId

    if (!selectedId || !delta) {
      return
    }

    const key = this.getActiveDecorItemsKey()
    const currentItems = this.getActiveDecorItems()
    const nextItems = currentItems.map((item) => {
      if (item.instanceId !== selectedId) {
        return item
      }

      const nextScale = Math.min(1.8, Math.max(0.7, Number(item.scale || 1) + delta))
      const baseWidth = Number(item.baseWidth || item.width || 156)
      const baseHeight = Number(item.baseHeight || item.height || 72)
      return {
        ...item,
        scale: Number(nextScale.toFixed(2)),
        width: Number((baseWidth * nextScale).toFixed(2)),
        height: Number((baseHeight * nextScale).toFixed(2)),
      }
    })

    this.setData({
      [key]: nextItems,
    })
  },

  removeSelectedDecorItem() {
    const selectedId = this.data.selectedDecorItemId

    if (!selectedId) {
      return
    }

    const key = this.getActiveDecorItemsKey()
    const nextItems = this.getActiveDecorItems().filter((item) => item.instanceId !== selectedId)

    this.setData({
      [key]: nextItems,
      selectedDecorItemId: '',
    })
    this.appendLog(`已从${this.getActiveWorkbenchSceneLabel()}移除一个家具素材。`)
  },

  clearWorkbenchScene() {
    const key = this.getActiveDecorItemsKey()

    this.setData({
      [key]: [],
      selectedDecorItemId: '',
    })
    this.appendLog(`已清空${this.getActiveWorkbenchSceneLabel()}上的手动摆放。`)
  },

  getActiveWorkbenchImageState() {
    if (this.data.activeWorkbenchScene === 'render') {
      return {
        sceneLabel: '3D 效果图',
        imagePath: this.data.renderImagePath,
        imageUrl: this.data.renderImageUrl,
        imageId: this.data.renderImageId,
        itemsKey: 'renderDecorItems',
        imagePathKey: 'renderImagePath',
        imageUrlKey: 'renderImageUrl',
        imageIdKey: 'renderImageId',
      }
    }

    return {
      sceneLabel: '2D 布局图',
      imagePath: this.data.floorPlanImagePath,
      imageUrl: this.data.floorPlanImageUrl,
      imageId: this.data.floorPlanImageId,
      itemsKey: 'floorPlanDecorItems',
      imagePathKey: 'floorPlanImagePath',
      imageUrlKey: 'floorPlanImageUrl',
      imageIdKey: 'floorPlanImageId',
    }
  },

  async ensureLocalImagePath(imagePath, imageUrl) {
    const localPath = String(imagePath || '').trim()

    if (localPath && !/^https?:\/\//i.test(localPath)) {
      return localPath
    }

    const remoteUrl = String(imageUrl || imagePath || '').trim()

    if (!remoteUrl) {
      throw new Error('当前场景缺少可编辑的基础图片。')
    }

    return downloadImageForDisplay(remoteUrl)
  },

  async generateControlledEditImage() {
    try {
      const activeScene = this.getActiveWorkbenchImageState()
      const items = this.getActiveDecorItems()

      if (!items.length) {
        wx.showToast({
          title: '请先摆放家具素材',
          icon: 'none',
        })
        return
      }

      if (!activeScene.imagePath && !activeScene.imageUrl) {
        throw new Error(`当前没有可编辑的${activeScene.sceneLabel}。`)
      }

      this.setData({
        controlledEditLoading: true,
        errorMessage: '',
        finalDesignText: '',
        finalDesignBlocks: [],
        finalDesignPrompt: '',
      })

      const uploadPath = await this.ensureLocalImagePath(activeScene.imagePath, activeScene.imageUrl)
      const controlledEditPrompt = buildControlledEditPrompt({
        form: this.data.form,
        sceneLabel: activeScene.sceneLabel,
        items,
      })

      this.appendLog(`开始根据当前摆放重新生成${activeScene.sceneLabel}。`)

      const response = await requestBackendFileUpload({
        baseUrl: this.data.form.baseUrl,
        path: '/api/generate/controlled-edit',
        filePath: uploadPath,
        formData: await this.buildImageUploadFormData({
          prompt: controlledEditPrompt,
          model: normalizeImageModel(this.data.form.imageModel),
          aspectRatio: this.data.form.aspectRatio || '4:3',
          imageSize: this.data.form.imageSize || '1K',
        }),
      })

      if (!response.imageBase64) {
        throw new Error('可控编辑已返回，但缺少图片数据。')
      }

      const nextImagePath = response.imageUrl
        ? await downloadImageForDisplay(response.imageUrl).catch(() => response.imageUrl)
        : ''

      this.setData({
        controlledEditLoading: false,
        controlledEditPrompt,
        [activeScene.imagePathKey]: nextImagePath,
        [activeScene.imageUrlKey]: response.imageUrl || '',
        [activeScene.imageIdKey]: response.imageId || '',
        [activeScene.itemsKey]: [],
        selectedDecorItemId: '',
      })
      this.syncCurrentPlanSnapshot()

      wx.showToast({
        title: '编辑后图片已更新',
        icon: 'success',
      })
      this.appendLog(`${activeScene.sceneLabel}已按当前摆放重新生成，并尽量保留原布局。`)
    } catch (error) {
      const errorMessage = error && error.message ? error.message : '可控编辑生成失败，请稍后重试。'
      this.setData({
        controlledEditLoading: false,
        errorMessage,
      })
      this.appendLog(`可控编辑生成失败：${errorMessage}`)
    }
  },

  async generateFinalDesignSummary() {
    const activeSceneLabel = this.getActiveWorkbenchSceneLabel()
    const editedItems = decorateItemsForPrompt(this.getActiveDecorItems(), activeSceneLabel)

    this.setData({
      finalSummaryLoading: true,
      errorMessage: '',
    })
    this.appendLog(`开始根据${activeSceneLabel}的人工微调结果生成最终说明。`)

    try {
      const response = await requestBackendJson({
        baseUrl: this.data.form.baseUrl,
        path: '/api/generate/final-design-summary',
        data: {
          model: normalizeTextModel(this.data.form.textModel),
          servicePeople: getEffectiveServicePeople(this.data.form),
          spaceType: getEffectiveSpaceType(this.data.form),
          areaText: this.data.form.areaText,
          budgetRange: getEffectiveBudgetRange(this.data.form),
          coreNeeds: this.data.form.coreNeeds,
          constraints: this.data.form.constraints,
          activeScene: this.data.activeWorkbenchScene,
          activeSceneLabel,
          editedItems,
          existingDesignText: this.data.finalDesignText || this.data.designText || '',
        },
      })

      const finalDesignText = response.text || '后端未返回最终说明，请稍后重试。'
      this.setData({
        finalSummaryLoading: false,
        finalDesignText,
        finalDesignBlocks: markdownToBlocks(finalDesignText),
        finalDesignPrompt: response.prompt || '',
      })
      this.syncCurrentPlanSnapshot()
      this.appendLog('最终说明生成完成。')
    } catch (error) {
      const errorMessage =
        error && error.message ? error.message : '最终说明生成失败，请稍后重试。'
      this.setData({
        finalSummaryLoading: false,
        errorMessage,
      })
      this.appendLog(`最终说明生成失败：${errorMessage}`)
    }
  },

  buildCurrentPlanRecord() {
    const { form } = this.data
    const latestRecord = this.data.latestPlanRecord
    const selectedFurnitureLabels = formatFurnitureLabels(form.selectedFurnitureIds || [])
    const recordId = this.data.currentPlanRecordId || (latestRecord && latestRecord.id) || createPlanRecordId()

    return buildPlanRecord({
      id: recordId,
      updatedAt: Date.now(),
      createdAt: (latestRecord && latestRecord.createdAt) || Date.now(),
      baseUrl: form.baseUrl,
      title: buildShareTitle(form),
      servicePeople: getEffectiveServicePeople(form),
      servicePeopleCustom: form.servicePeopleCustom,
      spaceType: getEffectiveSpaceType(form),
      spaceTypeCustom: form.spaceTypeCustom,
      areaText: form.areaText,
      budgetRange: getEffectiveBudgetRange(form),
      budgetRangeCustom: form.budgetRangeCustom,
      coreNeeds: form.coreNeeds,
      constraints: form.constraints,
      selectedFurnitureIds: form.selectedFurnitureIds,
      selectedFurnitureLabels,
      selectedFurnitureStyleIds: form.selectedFurnitureStyleIds || [],
      furnitureStyleText: form.furnitureStyleText || '',
      photoPaths: form.photoPaths || [],
      primaryViewIndex: clampPrimaryViewIndex(form.photoPaths, form.primaryViewIndex),
      floorPlanImageId: this.data.floorPlanImageId,
      floorPlanImageUrl: this.data.floorPlanImageUrl,
      floorPlanImagePath: this.data.floorPlanImagePath,
      renderImageId: this.data.renderImageId,
      renderImageUrl: this.data.renderImageUrl,
      renderImagePath: this.data.renderImagePath,
      renderViews: (this.data.renderViews || []).map((item) => ({
        sourceIndex: item.sourceIndex,
        title: item.title,
        imageId: item.imageId,
        imageUrl: item.imageUrl,
        imagePath: item.imagePath,
        isPrimary: item.isPrimary,
      })),
      designText: this.data.designText,
      finalDesignText: this.data.finalDesignText,
      finalDesignPrompt: this.data.finalDesignPrompt,
      coverImageUrl:
        this.data.renderImageUrl ||
        ((this.data.renderViews[0] && this.data.renderViews[0].imageUrl) || '') ||
        this.data.floorPlanImageUrl,
    })
  },

  syncCurrentPlanSnapshot() {
    const hasResult =
      this.data.floorPlanImageUrl ||
      this.data.floorPlanImagePath ||
      this.data.renderImageUrl ||
      this.data.renderImagePath ||
      (Array.isArray(this.data.renderViews) && this.data.renderViews.length) ||
      this.data.designText ||
      this.data.finalDesignText

    if (!hasResult) {
      return
    }

    const record = this.buildCurrentPlanRecord()
    const saved = saveCurrentPlanRecord(record)

    if (!saved) {
      return
    }

    saved.summaryExcerpt = buildSummaryExcerpt(saved.finalDesignText || saved.designText || '')

    upsertHistoryRecord(saved)
    this.setData({
      currentPlanRecordId: saved.id,
      latestPlanRecord: saved,
    })
  },

  buildDesignPdfPayload() {
    const { form } = this.data
    const designText = this.data.finalDesignText || this.data.designText || ''

    return {
      servicePeople: getEffectiveServicePeople(form),
      spaceType: getEffectiveSpaceType(form),
      areaText: form.areaText,
      budgetRange: getEffectiveBudgetRange(form),
      coreNeeds: form.coreNeeds,
      constraints: form.constraints,
      selectedFurnitureLabels: formatFurnitureLabels(form.selectedFurnitureIds || []),
      furnitureStyleText: form.furnitureStyleText || '',
      floorPlanImageId: this.data.floorPlanImageId,
      renderImageId: this.data.renderImageId,
      renderImageIds: (this.data.renderViews || []).map((item) => item.imageId).filter(Boolean),
      designText: this.data.designText || '',
      finalDesignText: this.data.finalDesignText || '',
      exportedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      shareTitle: buildShareTitle(form),
      effectiveDesignText: designText,
    }
  },

  async exportDesignPdf() {
    const { form } = this.data
    const designText = this.data.finalDesignText || this.data.designText || ''

    if (
      !this.data.floorPlanImageId &&
      !this.data.renderImageId &&
      !(Array.isArray(this.data.renderViews) && this.data.renderViews.length)
    ) {
      wx.showToast({
        title: '请先生成方案图',
        icon: 'none',
      })
      return
    }

    this.setData({
      pdfExportLoading: true,
      errorMessage: '',
    })
    this.appendLog('开始导出 PDF 方案文件。')

    try {
      const response = await requestBackendJson({
        baseUrl: form.baseUrl,
        path: '/api/export/design-pdf',
        data: this.buildDesignPdfPayload(),
        timeout: 240000,
      })

      if (!response.fileUrl) {
        if (!response.fileId) {
          throw new Error('后端未返回 PDF 下载地址。')
        }
      }

      const normalizedBaseUrl = String(form.baseUrl || '').replace(/\/+$/, '')
      const downloadUrl =
        response.fileId && normalizedBaseUrl
          ? `${normalizedBaseUrl}/api/generated-file/${response.fileId}`
          : response.fileUrl

      const downloadResult = await new Promise((resolve, reject) => {
        wx.downloadFile({
          url: downloadUrl,
          timeout: 240000,
          success: resolve,
          fail: reject,
        })
      })

      if (downloadResult.statusCode < 200 || downloadResult.statusCode >= 300 || !downloadResult.tempFilePath) {
        throw new Error(`下载 PDF 失败。status=${downloadResult.statusCode}`)
      }

      await new Promise((resolve, reject) => {
        wx.openDocument({
          filePath: downloadResult.tempFilePath,
          fileType: 'pdf',
          showMenu: true,
          success: resolve,
          fail: reject,
        })
      })

      this.setData({
        pdfExportLoading: false,
      })
      this.appendLog(`PDF 导出完成。fileName=${response.fileName || 'weiguang-space-design.pdf'}`)
      wx.showToast({
        title: 'PDF 已打开',
        icon: 'success',
      })
    } catch (error) {
      const errorMessage = error && error.message ? error.message : '导出 PDF 失败，请稍后重试。'
      this.setData({
        pdfExportLoading: false,
        errorMessage,
      })
      this.appendLog(`PDF 导出失败：${errorMessage}`)
    }
  },

  copyPrompt(event) {
    const key = event.currentTarget.dataset.key
    const text = this.data[key] || ''

    if (!text) {
      return
    }

    wx.setClipboardData({
      data: text,
    })
  },

  validateBeforeGenerate() {
    const { form } = this.data

    if (!form.photoPaths || !form.photoPaths.length) {
      throw new Error('请先上传空间现状照片。')
    }

    if (!form.baseUrl) {
      throw new Error('请先填写后端服务地址。')
    }
  },

  setGeneratingState({ generating, currentStepText = '', errorMessage = '' }) {
    this.setData({
      generating,
      currentStepText,
      errorMessage,
    })
  },

  resetOutputs({ keepFloorPlan = false } = {}) {
    this.setData({
      floorPlanImagePath: keepFloorPlan ? this.data.floorPlanImagePath : '',
      floorPlanImageUrl: keepFloorPlan ? this.data.floorPlanImageUrl : '',
      floorPlanImageId: keepFloorPlan ? this.data.floorPlanImageId : '',
      renderImagePath: '',
      renderImageUrl: '',
      renderImageId: '',
      renderViews: [],
      designText: '',
      designBlocks: [],
      floorPlanPrompt: keepFloorPlan ? this.data.floorPlanPrompt : '',
      renderPrompt: '',
      designPrompt: '',
      finalDesignText: '',
      finalDesignBlocks: [],
      finalDesignPrompt: '',
      finalSummaryLoading: false,
      controlledEditLoading: false,
      controlledEditPrompt: '',
      pdfExportLoading: false,
      currentPlanRecordId: keepFloorPlan ? this.data.currentPlanRecordId : '',
      floorPlanDecorItems: keepFloorPlan ? this.data.floorPlanDecorItems : [],
      renderDecorItems: [],
      selectedDecorItemId: '',
      activeWorkbenchScene: keepFloorPlan ? this.data.activeWorkbenchScene : 'floor',
      errorMessage: '',
    })
  },

  async runFloorPlanGeneration() {
    const { form } = this.data
    const startTime = Date.now()

    this.resetOutputs()
    this.setGeneratingState({
      generating: true,
      currentStepText: '正在上传空间照片并生成 2D 布局图',
      errorMessage: '',
    })
    this.appendLog('开始生成 2D 布局图。')

    const floorPlanPrompt = buildFloorPlanPrompt(form)
    const floorPlanResult = await requestBackendFileUpload({
      baseUrl: form.baseUrl,
      path: '/api/generate/floor-plan',
      filePath: form.photoPaths[0],
      formData: await this.buildImageUploadFormData({
        prompt: floorPlanPrompt,
        model: normalizeImageModel(form.imageModel),
        aspectRatio: form.aspectRatio || '4:3',
        imageSize: form.imageSize || '1K',
        includeFurnitureReferences: 'false',
      }),
    })

    if (!floorPlanResult.imageBase64) {
      throw new Error('2D 布局图生成成功，但后端响应中没有图片数据。')
    }

    const floorPlanImagePath = floorPlanResult.imageUrl
      ? await downloadImageForDisplay(floorPlanResult.imageUrl).catch(() => floorPlanResult.imageUrl)
      : ''

    const elapsedMs = Date.now() - startTime

    this.setData({
      floorPlanImagePath,
      floorPlanImageUrl: floorPlanResult.imageUrl || '',
      floorPlanImageId: floorPlanResult.imageId || '',
      floorPlanPrompt,
    })
    this.appendLog(`2D 布局图生成完成，用时 ${elapsedMs}ms。`)

    return {
      floorPlanImagePath,
      floorPlanImageUrl: floorPlanResult.imageUrl || '',
      floorPlanImageId: floorPlanResult.imageId || '',
      floorPlanPrompt,
      floorPlanText: floorPlanResult.text || '',
    }
  },

  async runRenderGeneration() {
    const { form } = this.data
    const startTime = Date.now()
    const photoPaths = [].concat(form.photoPaths || [])
    const totalCount = photoPaths.length
    const primaryViewIndex = clampPrimaryViewIndex(photoPaths, form.primaryViewIndex)
    const renderPrompt = buildRenderPrompt(form)
    const renderViews = []

    this.resetOutputs({ keepFloorPlan: true })
    this.setGeneratingState({
      generating: true,
      currentStepText:
        totalCount > 1
          ? `正在基于多张原图生成多视角 3D 效果图（1/${totalCount}）`
          : '正在基于原始空间照片生成 3D 效果图',
      errorMessage: '',
    })
      this.appendLog(
        totalCount > 1
          ? `开始生成多视角 3D 效果图，共 ${totalCount} 个视角，默认展示图为第 ${primaryViewIndex + 1} 张原图。`
          : '开始基于原始空间照片生成 3D 效果图。'
      )

    let primaryRenderText = ''

    for (let index = 0; index < totalCount; index += 1) {
      const orderedPhotoPaths = buildOrderedPhotoPaths(photoPaths, index)
      const isPrimary = index === primaryViewIndex

      this.setGeneratingState({
        generating: true,
        currentStepText:
          totalCount > 1
            ? `正在生成第 ${index + 1}/${totalCount} 张 3D 效果图`
            : '正在基于原始空间照片生成 3D 效果图',
        errorMessage: '',
      })
      this.appendLog(
        totalCount > 1
          ? `正在生成第 ${index + 1}/${totalCount} 个视角的 3D 效果图。`
          : '正在请求 3D 效果图。'
      )

      const viewPrompt = buildViewSpecificRenderPrompt(renderPrompt, index, totalCount, isPrimary)
      const renderResult = await requestBackendFileUpload({
        baseUrl: form.baseUrl,
        path: '/api/generate/render',
        filePath: orderedPhotoPaths[0],
        name: 'referenceImage',
        formData: await this.buildImageUploadFormData(
          {
            prompt: viewPrompt,
            model: normalizeImageModel(form.imageModel),
            aspectRatio: form.aspectRatio || '4:3',
            imageSize: form.imageSize || '1K',
          },
          {
            photoPaths: orderedPhotoPaths.slice(1),
          }
        ),
      })

      if (!renderResult.imageBase64) {
        throw new Error('3D 效果图生成成功，但后端响应中没有图片数据。')
      }

      const imagePath = renderResult.imageUrl
        ? await downloadImageForDisplay(renderResult.imageUrl).catch(() => renderResult.imageUrl)
        : ''
      const renderView = {
        sourceIndex: index,
        title: buildRenderViewTitle(index, totalCount, isPrimary),
        imagePath,
        imageUrl: renderResult.imageUrl || '',
        imageId: renderResult.imageId || '',
        isPrimary,
      }

      renderViews.push(renderView)

      if (isPrimary || (!primaryRenderText && totalCount === 1)) {
        primaryRenderText = renderResult.text || ''
      }
    }

    const primaryRenderView = renderViews.find((item) => item.isPrimary) || renderViews[0] || null
    const elapsedMs = Date.now() - startTime

    this.setData({
      renderImagePath: primaryRenderView ? primaryRenderView.imagePath : '',
      renderImageUrl: primaryRenderView ? primaryRenderView.imageUrl : '',
      renderImageId: primaryRenderView ? primaryRenderView.imageId : '',
      renderViews,
      renderPrompt,
    })
    this.appendLog(
      totalCount > 1
        ? `多视角 3D 效果图生成完成，共 ${renderViews.length} 张，用时 ${elapsedMs}ms。`
        : `3D 效果图生成完成，用时 ${elapsedMs}ms。`
    )

    return {
      renderImagePath: primaryRenderView ? primaryRenderView.imagePath : '',
      renderImageUrl: primaryRenderView ? primaryRenderView.imageUrl : '',
      renderImageId: primaryRenderView ? primaryRenderView.imageId : '',
      renderViews,
      renderPrompt,
      renderText: primaryRenderText,
    }
  },

  async runDesignSummaryGeneration(extraContext) {
    const { form } = this.data
    const startTime = Date.now()

    this.setGeneratingState({
      generating: true,
      currentStepText: '正在生成中文设计说明',
      errorMessage: '',
    })
    this.appendLog('开始生成中文设计说明。')

    const designPrompt = buildDesignPrompt(form, extraContext)
    const response = await requestBackendJson({
      baseUrl: form.baseUrl,
      path: '/api/generate/design-summary',
      data: {
        prompt: designPrompt,
        model: normalizeTextModel(form.textModel),
        servicePeople: getEffectiveServicePeople(form),
        spaceType: getEffectiveSpaceType(form),
        areaText: form.areaText,
        budgetRange: getEffectiveBudgetRange(form),
        coreNeeds: form.coreNeeds,
        constraints: form.constraints,
        selectedFurnitureIds: form.selectedFurnitureIds,
      },
    })
    const designText = response.text || '后端未返回文本说明，请重试。'
    const designBlocks = markdownToBlocks(designText)
    const elapsedMs = Date.now() - startTime

    this.setData({
      designPrompt,
      designText,
      designBlocks,
    })
    this.syncCurrentPlanSnapshot()
    this.appendLog(`中文设计说明生成完成，用时 ${elapsedMs}ms。`)

    return {
      designPrompt,
      designText,
      designBlocks,
    }
  },

  async handleGenerateRenderOnly() {
    try {
      this.validateBeforeGenerate()

      const renderResult = await this.runRenderGeneration()
      const extraContext = [
        renderResult.renderText ? `3D 模型说明：${renderResult.renderText}` : '',
      ]
        .filter(Boolean)
        .join('\n')

      await this.runDesignSummaryGeneration(extraContext)
      this.setGeneratingState({
        generating: false,
        currentStepText: '完整方案生成完成',
        errorMessage: '',
      })
    } catch (error) {
      this.handleGenerateError(error)
    }
  },

  async handleGenerateAll() {
    try {
      this.validateBeforeGenerate()
      this.stopTaskPolling()
      this.resetOutputs()

      const floorPlanPrompt = buildFloorPlanPrompt(this.data.form)
      const renderPrompt = buildRenderPrompt(this.data.form)

      this.setData({
        generating: true,
        errorMessage: '',
        currentStepText: '正在创建生成任务',
        floorPlanPrompt,
        renderPrompt,
        designPrompt: '',
        progressPercent: 2,
        progressTitle: '正在创建生成任务',
        progressHint: '上传原图后会优先生成 3D 效果图，通常需要等待几分钟，请保持页面打开',
        progressEtaText: this.buildProgressEtaText({}),
      })
      this.appendLog('开始创建完整方案任务。')

      const taskResponse = await requestBackendFileUpload({
        baseUrl: this.data.form.baseUrl,
        path: '/api/tasks/create',
        filePath: this.data.form.photoPaths[0],
        formData: await this.buildImageUploadFormData({
          floorPlanPrompt,
          renderPrompt,
          imageModel: normalizeImageModel(this.data.form.imageModel),
          textModel: normalizeTextModel(this.data.form.textModel),
          primaryViewIndex: clampPrimaryViewIndex(
            this.data.form.photoPaths,
            this.data.form.primaryViewIndex
          ),
          aspectRatio: this.data.form.aspectRatio || '4:3',
          imageSize: this.data.form.imageSize || '1K',
        }),
      })

      if (!taskResponse.taskId) {
        throw new Error('创建任务失败：后端未返回 taskId。')
      }

      this.saveActiveTask({
        taskId: taskResponse.taskId,
        baseUrl: this.data.form.baseUrl,
      })
      this.setData({
        currentStepText: taskResponse.progressTitle || '任务已创建',
        progressPercent: taskResponse.progressPercent || 2,
        progressTitle: taskResponse.progressTitle || '任务已创建',
        progressHint: taskResponse.progressHint || '3D 效果图会先返回显示，2D 布局图和说明随后补齐',
        progressEtaText: this.buildProgressEtaText(taskResponse.result || {}),
      })
      this.appendLog(`任务已创建。taskId=${taskResponse.taskId}`)
      this.startTaskPolling(taskResponse.taskId, this.data.form.baseUrl)
      await this.fetchTaskStatus(taskResponse.taskId, this.data.form.baseUrl, true)
    } catch (error) {
      this.clearActiveTask()
      this.stopTaskPolling()
      this.handleGenerateError(error)
    }
  },

  handleGenerateError(error) {
    const errorMessage =
      error && error.message ? error.message : '生成失败，请检查网络、接口配置或提示词。'

    this.setGeneratingState({
      generating: false,
      currentStepText: '',
      errorMessage,
    })
    this.setData({
      progressPercent: 0,
      progressTitle: '',
      progressHint: '',
      progressEtaText: '',
    })
    this.appendLog(`生成失败：${errorMessage}`)
    console.error('[微光空间] generate failed', error)
  },
})
