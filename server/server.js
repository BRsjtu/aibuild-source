/**
 * 微光空间后端服务。
 *
 * 作用：
 * - 提供小程序需要的健康检查接口。
 * - 提供 2D 布局图生成接口。
 * - 提供伪 3D 效果图生成接口。
 * - 提供中文设计说明生成接口。
 * - 由业务后端转调统一 AI 网关，前端不暴露上游模型密钥。
 *
 * 启动示例：
 * `AI_GATEWAY_BASE_URL=http://127.0.0.1:3010/ai node server/server.js`
 *
 * 常用环境变量：
 * - `HOST`：监听地址，默认 `127.0.0.1`
 * - `PORT`：监听端口，默认 `3000`
 * - `REQUEST_TIMEOUT_MS`：统一 AI 网关请求超时，默认 `420000`
 * - `AI_GATEWAY_BASE_URL`：统一 AI 网关地址，默认 `http://127.0.0.1:3010/ai`
 * - `VISION_MODEL`：图像模型，默认 `gpt-image-2`
 * - `TEXT_MODEL`：文本模型，默认 `deepseek-v4-flash`
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const Busboy = require('busboy')
const PDFDocument = require('pdfkit')
const { URL } = require('url')
const FURNITURE_LIBRARY = require('./data/furniture-library.json')
const FURNITURE_STYLE_LIBRARY = require('./data/furniture-styles.json')
const CASE_LIBRARY = require('./data/case-library.json')

const DEFAULT_VISION_MODEL = 'gpt-image-2'
const FALLBACK_IMAGE_MODEL = 'gemini-3.1-flash-image-preview'
const DEFAULT_TEXT_MODEL = 'deepseek-v4-flash'
const DEFAULT_TIMEOUT_MS = 420000
const DEFAULT_AI_GATEWAY_BASE_URL = 'http://127.0.0.1:3010/ai'
const DEFAULT_BASE_URL = 'https://yunwu.ai/v1'
const DEFAULT_API_KEY = ''
const PROJECT_ROOT = path.resolve(__dirname, '..')
const CASE_ASSET_ROOT = path.join(PROJECT_ROOT, 'demo-images-cn')
const FURNITURE_STYLE_ASSET_ROOT = path.join(__dirname, 'runtime-assets', 'furniture')
const GENERATED_ASSET_ROOT = getEnvString(
  'GENERATED_ASSET_ROOT',
  path.join(__dirname, 'runtime-generated')
)
const GENERATED_IMAGE_ROOT = path.join(GENERATED_ASSET_ROOT, 'images')
const GENERATED_IMAGE_CACHE = new Map()
const MAX_GENERATED_IMAGE_CACHE_SIZE = 100
const GENERATED_FILE_CACHE = new Map()
const MAX_GENERATED_FILE_CACHE_SIZE = 10
const SHARED_PLAN_CACHE = new Map()
const MAX_SHARED_PLAN_CACHE_SIZE = 50
const TASK_CACHE = new Map()
const MAX_TASK_CACHE_SIZE = 50
const PDF_FONT_CANDIDATE_PATHS = [
  getEnvString('PDF_FONT_PATH', ''),
  path.join(__dirname, 'runtime-assets', 'fonts', 'simhei.ttf'),
  path.join(__dirname, 'runtime-assets', 'fonts', 'NotoSansCJK-Regular.otf'),
  path.join(__dirname, 'runtime-assets', 'fonts', 'msyh.ttc'),
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf',
  '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.otf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
  '/usr/share/fonts/truetype/arphic/ukai.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\msyh.ttf',
  'C:\\Windows\\Fonts\\msyh.ttc',
]

/**
 * 读取环境变量字符串。
 *
 * @param {string} key 环境变量名。
 * @param {string} fallback 默认值。
 * @returns {string} 处理后的字符串值。
 *
 * 使用示例：
 * `const host = getEnvString('HOST', '127.0.0.1')`
 */
function getEnvString(key, fallback = '') {
  const value = process.env[key]

  if (typeof value !== 'string') {
    return fallback
  }

  const trimmed = value.trim()
  return trimmed || fallback
}

/**
 * 读取环境变量数字。
 *
 * @param {string} key 环境变量名。
 * @param {number} fallback 默认值。
 * @returns {number} 合法数字或默认值。
 *
 * 使用示例：
 * `const port = getEnvNumber('PORT', 3000)`
 */
function getEnvNumber(key, fallback) {
  const value = Number(process.env[key])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 统一输出日志。
 *
 * @param {string} level 日志级别。
 * @param {string} requestId 请求 ID。
 * @param {string} message 日志内容。
 * @param {Object} [extra] 额外信息。
 *
 * 使用示例：
 * `log('info', 'req-1', '开始请求上游接口', { path: '/health' })`
 */
function log(level, requestId, message, extra) {
  const payload = {
    time: new Date().toISOString(),
    level,
    requestId,
    message,
  }

  if (extra && typeof extra === 'object') {
    payload.extra = extra
  }

  console.log(JSON.stringify(payload))
}

/**
 * 规范化基础地址。
 *
 * @param {string} baseUrl 上游基础地址。
 * @returns {string} 去除末尾斜杠后的地址。
 *
 * 使用示例：
 * `normalizeBaseUrl('https://yunwu.ai/v1/')`
 */
function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '')
}

/**
 * 构造 Gemini 原生接口地址。
 *
 * @param {Object} params 参数对象。
 * @param {string} params.baseUrl 上游基础地址。
 * @param {string} params.apiKey 上游 API Key。
 * @param {string} params.model 模型名称。
 * @returns {string} 完整请求地址。
 *
 * 使用示例：
 * `buildNativeUrl({ baseUrl, apiKey, model: 'gemini-3.1-flash-image-preview' })`
 */
function buildNativeUrl({ baseUrl, apiKey, model }) {
  const root = normalizeBaseUrl(baseUrl).replace(/\/v1(?:beta)?$/i, '')
  const encodedKey = encodeURIComponent(apiKey)
  return `${root}/v1beta/models/${model}:generateContent?key=${encodedKey}`
}

function buildOpenAIUrl({ baseUrl, path }) {
  let root = normalizeBaseUrl(baseUrl).replace(/\/v1beta$/i, '')

  if (!/\/v1$/i.test(root)) {
    root = `${root}/v1`
  }

  const normalizedPath = String(path || '').startsWith('/') ? path : `/${path}`
  return `${root}${normalizedPath}`
}

function selectRequestedModel(requestValue, fallbackValue) {
  if (typeof requestValue === 'string' && requestValue.trim()) {
    return requestValue.trim()
  }

  return fallbackValue
}

function isOpenAIImageModel(model) {
  return /^gpt-image-/i.test(String(model || '').trim())
}

function getImageFallbackModels(model) {
  const requested = String(model || '').trim()

  if (!isOpenAIImageModel(requested) || requested === FALLBACK_IMAGE_MODEL) {
    return []
  }

  return [FALLBACK_IMAGE_MODEL]
}

function buildGatewayImageEditBody({ model, prompt, aspectRatio, imageSize, images }) {
  return {
    model,
    prompt,
    aspectRatio,
    size: isOpenAIImageModel(model) ? mapOpenAIImageSize(aspectRatio) : undefined,
    quality: isOpenAIImageModel(model) ? mapGatewayImageQuality(imageSize) : undefined,
    images,
  }
}

function isOpenAITextModel(model) {
  return /^gpt-/i.test(String(model || '').trim())
}

function isImageModelName(model) {
  const value = String(model || '').trim()
  return /^gpt-image-/i.test(value) || /-image-/i.test(value)
}

function selectRequestedTextModel(requestValue, fallbackValue) {
  const requested = selectRequestedModel(requestValue, fallbackValue)
  return isImageModelName(requested) ? fallbackValue : requested
}

function mapOpenAIImageSize(aspectRatio) {
  const value = String(aspectRatio || '4:3').trim()

  if (value === '1:1') {
    return '1024x1024'
  }

  if (value === '3:4' || value === '9:16') {
    return '1024x1536'
  }

  return '1536x1024'
}

function mapOpenAIImageQuality(imageSize) {
  const value = String(imageSize || '').trim().toUpperCase()

  if (value === '2K') {
    return 'high'
  }

  return 'medium'
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 解析请求体 JSON。
 *
 * @param {http.IncomingMessage} req Node 请求对象。
 * @returns {Promise<Object>} JSON 对象。
 *
 * 使用示例：
 * `const body = await readJsonBody(req)`
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []

    req.on('data', (chunk) => {
      chunks.push(chunk)
    })

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON。detail=${error.message}`))
      }
    })

    req.on('error', (error) => {
      reject(new Error(`读取请求体失败。detail=${error.message}`))
    })
  })
}

/**
 * 解析 multipart 中的 extraImagesJson（第 2～N 张图的 base64 列表）。
 *
 * @param {string} raw 原始 JSON 字符串。
 * @returns {Array<Object>} 解析后的对象数组。
 */
function parseExtraImagesJsonField(raw) {
  if (!raw || typeof raw !== 'string') {
    return []
  }

  try {
    const parsed = JSON.parse(raw)

    if (Array.isArray(parsed)) {
      return parsed
    }

    if (parsed && typeof parsed === 'object') {
      return [parsed]
    }

    return []
  } catch (error) {
    return []
  }
}

function buildUploadedFilesFromMultipart({ fileBuffer, fileMimeType, fields }) {
  const uploadedFiles = []

  if (fileBuffer && Buffer.isBuffer(fileBuffer) && fileBuffer.length) {
    uploadedFiles.push({
      buffer: fileBuffer,
      mimeType: fileMimeType || fields.mimeType || 'image/jpeg',
    })
  }

  parseExtraImagesJsonField(fields.extraImagesJson).forEach((item) => {
    if (!item || typeof item.data !== 'string' || !item.data.trim()) {
      return
    }

    try {
      const buffer = Buffer.from(item.data, 'base64')

      if (buffer.length) {
        uploadedFiles.push({
          buffer,
          mimeType:
            typeof item.mimeType === 'string' && item.mimeType.trim()
              ? item.mimeType.trim()
              : 'image/jpeg',
        })
      }
    } catch (error) {
      log('warn', 'multipart', '跳过无效的附加图片 base64', {
        detail: error.message,
      })
    }
  })

  return uploadedFiles
}

/**
 * 解析 multipart/form-data 请求体。
 *
 * @param {http.IncomingMessage} req Node 请求对象。
 * @returns {Promise<Object>} 表单字段与文件信息。
 *
 * 使用示例：
 * `const body = await readMultipartBody(req)`
 */
function readMultipartBody(req) {
  return new Promise((resolve, reject) => {
    const fields = {}
    let fileBuffer = null
    let fileName = ''
    let fileMimeType = ''
    let rejected = false
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: 20 * 1024 * 1024,
      },
    })

    function rejectOnce(error) {
      if (!rejected) {
        rejected = true
        reject(error)
      }
    }

    busboy.on('field', (name, value) => {
      fields[name] = value
    })

    busboy.on('file', (name, file, info) => {
      const chunks = []

      fileName = info && info.filename ? info.filename : ''
      fileMimeType = info && info.mimeType ? info.mimeType : ''

      file.on('data', (chunk) => {
        chunks.push(chunk)
      })

      file.on('limit', () => {
        rejectOnce(new Error('上传图片过大，请控制在 20MB 以内。'))
      })

      file.on('end', () => {
        fileBuffer = Buffer.concat(chunks)
      })

      file.on('error', (error) => {
        rejectOnce(new Error(`读取上传文件失败。detail=${error.message}`))
      })
    })

    busboy.on('error', (error) => {
      rejectOnce(new Error(`解析上传表单失败。detail=${error.message}`))
    })

    busboy.on('finish', () => {
      if (rejected) {
        return
      }

      const uploadedFiles = buildUploadedFilesFromMultipart({
        fileBuffer,
        fileMimeType,
        fields,
      })
      const first = uploadedFiles[0]

      resolve({
        ...fields,
        fileBuffer: first ? first.buffer : null,
        fileName,
        mimeType: first ? first.mimeType : fileMimeType || fields.mimeType || '',
        uploadedFiles,
      })
    })

    req.pipe(busboy)
  })
}

/**
 * 统一读取请求体。
 *
 * @param {http.IncomingMessage} req Node 请求对象。
 * @returns {Promise<Object>} 请求体对象。
 *
 * 使用示例：
 * `const body = await readRequestBody(req)`
 */
function readRequestBody(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase()

  if (contentType.includes('multipart/form-data')) {
    return readMultipartBody(req)
  }

  return readJsonBody(req)
}

/**
 * 发送 JSON 响应。
 *
 * @param {http.ServerResponse} res Node 响应对象。
 * @param {number} statusCode HTTP 状态码。
 * @param {Object} payload 返回对象。
 *
 * 使用示例：
 * `sendJson(res, 200, { ok: true })`
 */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  })
  res.end(body)
}

function sendBinary(res, statusCode, buffer, mimeType, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': mimeType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  })
  res.end(buffer)
}

function normalizeJsonImageUploads(body) {
  if (!body || typeof body !== 'object') {
    return body || {}
  }

  const alreadyHasUpload =
    (body.fileBuffer && Buffer.isBuffer(body.fileBuffer) && body.fileBuffer.length > 0) ||
    (Array.isArray(body.uploadedFiles) &&
      body.uploadedFiles.some(
        (item) => item && item.buffer && Buffer.isBuffer(item.buffer) && item.buffer.length > 0
      ))

  if (alreadyHasUpload || typeof body.imageBase64 !== 'string' || !body.imageBase64.trim()) {
    return body
  }

  const normalizedBase64 = body.imageBase64.replace(/^data:[^;]+;base64,/, '').trim()
  const fileBuffer = Buffer.from(normalizedBase64, 'base64')

  if (!fileBuffer.length || fileBuffer.length > 20 * 1024 * 1024) {
    throw new Error('上传图片无效或超过 20MB 限制。')
  }

  const uploadedFiles = buildUploadedFilesFromMultipart({
    fileBuffer,
    fileMimeType: body.mimeType || inferImageMimeTypeFromBase64(normalizedBase64),
    fields: body,
  })
  const first = uploadedFiles[0]
  const {
    imageBase64,
    extraImagesJson,
    ...taskFields
  } = body

  return {
    ...taskFields,
    fileBuffer: first ? first.buffer : null,
    mimeType: first ? first.mimeType : body.mimeType || '',
    uploadedFiles,
  }
}

/**
 * 校验字符串字段。
 *
 * @param {Object} body 请求体。
 * @param {string} key 字段名。
 * @returns {string} 非空字符串。
 *
 * 使用示例：
 * `const prompt = requireString(body, 'prompt')`
 */
function requireString(body, key) {
  const value = body ? body[key] : ''

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`缺少必要字段：${key}`)
  }

  return value.trim()
}

/**
 * 从模型响应中提取图片和文本。
 *
 * @param {Object} response 上游原始响应。
 * @returns {{imageBase64: string, text: string}} 提取后的结果。
 *
 * 使用示例：
 * `const parsed = parseGeminiResponse(responseJson)`
 */
function parseGeminiResponse(response) {
  const candidates = Array.isArray(response && response.candidates) ? response.candidates : []
  const first = candidates[0] || {}
  const content = first.content || {}
  const parts = Array.isArray(content.parts) ? content.parts : []

  let imageBase64 = ''
  let imageMimeType = ''
  const textList = []

  parts.forEach((part) => {
    if (part && typeof part.text === 'string' && part.text.trim()) {
      textList.push(part.text.trim())
    }

    if (!imageBase64 && part && part.inline_data && part.inline_data.data) {
      imageBase64 = part.inline_data.data
      imageMimeType = part.inline_data.mime_type || ''
    }

    if (!imageBase64 && part && part.inlineData && part.inlineData.data) {
      imageBase64 = part.inlineData.data
      imageMimeType = part.inlineData.mimeType || part.inlineData.mime_type || ''
    }
  })

  return {
    imageBase64,
    imageMimeType,
    text: textList.join('\n').trim(),
  }
}

function parseOpenAIImageResponse(response) {
  const dataList = Array.isArray(response && response.data) ? response.data : []
  const first = dataList[0] || {}

  return {
    imageBase64: typeof first.b64_json === 'string' ? first.b64_json.trim() : '',
    imageMimeType: 'image/png',
    text: typeof first.revised_prompt === 'string' ? first.revised_prompt.trim() : '',
  }
}

function parseOpenAITextResponse(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim()
  }

  if (Array.isArray(response?.choices)) {
    const content = response.choices[0]?.message?.content

    if (typeof content === 'string' && content.trim()) {
      return content.trim()
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item?.text === 'string') {
            return item.text.trim()
          }

          if (typeof item === 'string') {
            return item.trim()
          }

          return ''
        })
        .filter(Boolean)
        .join('\n')
        .trim()
    }
  }

  const outputList = Array.isArray(response?.output) ? response.output : []
  const textList = []

  outputList.forEach((outputItem) => {
    const contentList = Array.isArray(outputItem?.content) ? outputItem.content : []

    contentList.forEach((contentItem) => {
      if (typeof contentItem?.text === 'string' && contentItem.text.trim()) {
        textList.push(contentItem.text.trim())
      }
    })
  })

  return textList.join('\n').trim()
}

function inferImageMimeTypeFromBase64(base64Data) {
  const normalized = String(base64Data || '').trim()

  if (normalized.indexOf('/9j/') === 0) {
    return 'image/jpeg'
  }

  if (normalized.indexOf('iVBOR') === 0) {
    return 'image/png'
  }

  if (normalized.indexOf('UklGR') === 0) {
    return 'image/webp'
  }

  return 'image/png'
}

function buildPublicBaseUrl(req, config) {
  const hostHeader = String(req.headers.host || `${config.host}:${config.port}`)
  return `http://${hostHeader}${config.publicBasePath || ''}`
}

function inferMimeTypeFromFileName(fileName) {
  const lower = String(fileName || '').toLowerCase()

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

function resolveCaseAssetPath(relativePath) {
  const raw = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const absolute = path.resolve(CASE_ASSET_ROOT, raw)

  if (!absolute.startsWith(CASE_ASSET_ROOT)) {
    throw new Error(`非法案例素材路径。path=${relativePath}`)
  }

  return absolute
}

function buildCaseImageUrl(publicBaseUrl, relativePath) {
  if (!relativePath) {
    return ''
  }

  return `${publicBaseUrl}/api/case-image/${encodeURIComponent(relativePath)}`
}

function getCaseCoverThumbnailPath(item) {
  const coverPath = String((item && item.coverImagePath) || '')

  if (!coverPath) {
    return ''
  }

  const directory = path.posix.dirname(coverPath.replace(/\\/g, '/'))
  const thumbnailPath = path.posix.join(directory, 'cover-thumb.jpg')

  try {
    const absoluteThumbnailPath = resolveCaseAssetPath(thumbnailPath)
    return fs.existsSync(absoluteThumbnailPath) ? thumbnailPath : ''
  } catch (error) {
    return ''
  }
}

function buildCaseLibraryItem(publicBaseUrl, item, options = {}) {
  const detail = options.detail === true
  const thumbnailPath = getCaseCoverThumbnailPath(item)
  const baseItem = {
    id: item.id,
    reviewIndex: item.reviewIndex,
    title: item.title,
    subtitle: item.subtitle,
    spaceType: item.spaceType,
    targetUsers: item.targetUsers,
    budgetRange: item.budgetRange,
    generationModel: item.generationModel,
    modelNote: item.modelNote,
    tags: item.tags,
    highlight: item.highlight,
    coreNeeds: item.coreNeeds,
    constraints: item.constraints,
    layoutSummary: item.layoutSummary,
    summary: item.summary,
    coverImageUrl: buildCaseImageUrl(publicBaseUrl, thumbnailPath || item.coverImagePath),
    coverPreviewImageUrl: buildCaseImageUrl(publicBaseUrl, item.coverImagePath),
  }

  if (!detail) {
    return baseItem
  }

  return {
    ...baseItem,
    beforeImageUrl: buildCaseImageUrl(publicBaseUrl, item.beforeImagePath),
    floorPlanImageUrl: buildCaseImageUrl(publicBaseUrl, item.floorPlanImagePath),
    renderImageUrl: buildCaseImageUrl(publicBaseUrl, item.renderImagePath),
  }
}

function buildCaseLibraryResponse(publicBaseUrl, options = {}) {
  return CASE_LIBRARY.map((item) => buildCaseLibraryItem(publicBaseUrl, item, options))
}

function findCaseLibraryItem(caseId) {
  return CASE_LIBRARY.find((item) => item.id === caseId) || null
}

function resolveFurnitureStyleAssetPath(relativePath) {
  const raw = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const absolute = path.resolve(FURNITURE_STYLE_ASSET_ROOT, raw)

  if (!absolute.startsWith(FURNITURE_STYLE_ASSET_ROOT)) {
    throw new Error(`非法家具款式素材路径。path=${relativePath}`)
  }

  return absolute
}

function buildFurnitureStyleLibraryResponse(publicBaseUrl) {
  return FURNITURE_STYLE_LIBRARY.map((group) => ({
    furnitureId: group.furnitureId,
    furnitureLabel: group.furnitureLabel,
    styles: (group.styles || []).map((item) => ({
      ...item,
      imageUrl: item.imagePath
        ? `${publicBaseUrl}/api/furniture-style-image/${encodeURIComponent(item.imagePath)}`
        : '',
    })),
  }))
}

function flattenFurnitureStyleItems() {
  const items = []

  FURNITURE_STYLE_LIBRARY.forEach((group) => {
    ;(group.styles || []).forEach((item) => {
      items.push({
        ...item,
        furnitureId: group.furnitureId,
        furnitureLabel: group.furnitureLabel,
      })
    })
  })

  return items
}

function pruneGeneratedImageCache() {
  while (GENERATED_IMAGE_CACHE.size > MAX_GENERATED_IMAGE_CACHE_SIZE) {
    const oldestKey = GENERATED_IMAGE_CACHE.keys().next().value
    GENERATED_IMAGE_CACHE.delete(oldestKey)
  }
}

function pruneGeneratedFileCache() {
  while (GENERATED_FILE_CACHE.size > MAX_GENERATED_FILE_CACHE_SIZE) {
    const oldestKey = GENERATED_FILE_CACHE.keys().next().value
    GENERATED_FILE_CACHE.delete(oldestKey)
  }
}

function pruneSharedPlanCache() {
  while (SHARED_PLAN_CACHE.size > MAX_SHARED_PLAN_CACHE_SIZE) {
    const oldestKey = SHARED_PLAN_CACHE.keys().next().value
    SHARED_PLAN_CACHE.delete(oldestKey)
  }
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true })
}

function isSafeGeneratedId(imageId) {
  return /^[a-zA-Z0-9_-]+$/.test(String(imageId || '').trim())
}

function getImageExtensionFromMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase()

  if (value.indexOf('jpeg') >= 0 || value.indexOf('jpg') >= 0) {
    return 'jpg'
  }

  if (value.indexOf('webp') >= 0) {
    return 'webp'
  }

  return 'png'
}

function getGeneratedImageDiskPaths(imageId, mimeType) {
  const extension = getImageExtensionFromMimeType(mimeType)

  return {
    imagePath: path.join(GENERATED_IMAGE_ROOT, `${imageId}.${extension}`),
    metaPath: path.join(GENERATED_IMAGE_ROOT, `${imageId}.json`),
  }
}

function writeGeneratedImageToDisk({ id, mimeType, buffer, createdAt }) {
  ensureDirectory(GENERATED_IMAGE_ROOT)
  const diskPaths = getGeneratedImageDiskPaths(id, mimeType)
  fs.writeFileSync(diskPaths.imagePath, buffer)
  fs.writeFileSync(
    diskPaths.metaPath,
    JSON.stringify(
      {
        id,
        mimeType,
        fileName: path.basename(diskPaths.imagePath),
        createdAt,
      },
      null,
      2
    )
  )

  return diskPaths.imagePath
}

function readGeneratedImageFromDisk(imageId) {
  const normalizedId = String(imageId || '').trim()

  if (!isSafeGeneratedId(normalizedId)) {
    return null
  }

  const metaPath = path.join(GENERATED_IMAGE_ROOT, `${normalizedId}.json`)

  if (!fs.existsSync(metaPath)) {
    return null
  }

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    const fileName = String(meta.fileName || '').trim()
    const imagePath = path.join(GENERATED_IMAGE_ROOT, fileName)

    if (!fileName || path.dirname(imagePath) !== GENERATED_IMAGE_ROOT || !fs.existsSync(imagePath)) {
      return null
    }

    const cachedImage = {
      id: normalizedId,
      mimeType: String(meta.mimeType || inferMimeTypeFromFileName(imagePath) || 'image/png'),
      buffer: fs.readFileSync(imagePath),
      createdAt: Number(meta.createdAt) || 0,
      filePath: imagePath,
    }

    GENERATED_IMAGE_CACHE.set(normalizedId, cachedImage)
    pruneGeneratedImageCache()
    return cachedImage
  } catch (error) {
    return null
  }
}

function cacheGeneratedImage({ imageBase64, imageMimeType }) {
  if (typeof imageBase64 !== 'string' || !imageBase64.trim()) {
    throw new Error('模型未返回可用图片。')
  }

  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const mimeType = imageMimeType || inferImageMimeTypeFromBase64(imageBase64)
  const buffer = Buffer.from(imageBase64, 'base64')
  const createdAt = Date.now()
  const filePath = writeGeneratedImageToDisk({ id, mimeType, buffer, createdAt })

  GENERATED_IMAGE_CACHE.set(id, {
    id,
    mimeType,
    buffer,
    createdAt,
    filePath,
  })
  pruneGeneratedImageCache()

  return {
    id,
    mimeType,
  }
}

function cacheGeneratedFile({ buffer, mimeType, fileName }) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`

  GENERATED_FILE_CACHE.set(id, {
    id,
    mimeType,
    fileName,
    buffer,
    createdAt: Date.now(),
  })
  pruneGeneratedFileCache()

  return {
    id,
    mimeType,
    fileName,
  }
}

function cacheSharedPlan(plan) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const normalized = {
    id,
    plan: {
      ...(plan || {}),
    },
    createdAt: Date.now(),
  }

  SHARED_PLAN_CACHE.set(id, normalized)
  pruneSharedPlanCache()
  return normalized
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  }

  if (typeof value !== 'string' || !value.trim()) {
    return []
  }

  try {
    const parsed = JSON.parse(value)
    return normalizeStringArray(parsed)
  } catch (error) {
    return value
      .split(/[\n,，、]/)
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  }
}

function sanitizeMarkdownForPdf(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^#{1,6}\s*/g, '')
        .replace(/^\s*[-*]\s+/g, '• ')
        .replace(/^\s*\d+\.\s+/g, (match) => match.trim())
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
    )
    .join('\n')
    .trim()
}

function resolvePdfFontPath() {
  for (let i = 0; i < PDF_FONT_CANDIDATE_PATHS.length; i += 1) {
    const candidate = String(PDF_FONT_CANDIDATE_PATHS[i] || '').trim()

    if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      continue
    }

    const isExplicitFontPath = i === 0 && Boolean(getEnvString('PDF_FONT_PATH', ''))
    const extension = path.extname(candidate).toLowerCase()

    if (!isExplicitFontPath && extension !== '.ttf' && extension !== '.otf') {
      continue
    }

    if (candidate) {
      return candidate
    }
  }

  return ''
}

function getCachedImageById(imageId) {
  const normalizedId = String(imageId || '').trim()

  if (!normalizedId) {
    return null
  }

  return GENERATED_IMAGE_CACHE.get(normalizedId) || readGeneratedImageFromDisk(normalizedId)
}

function buildPdfFileName(servicePeople, spaceType) {
  const safeServicePeople = String(servicePeople || '微光空间').replace(/[\\/:*?"<>|]/g, '').trim()
  const safeSpaceType = String(spaceType || '方案').replace(/[\\/:*?"<>|]/g, '').trim()
  const stamp = new Date().toISOString().slice(0, 10)
  return `${safeServicePeople || '微光空间'}-${safeSpaceType || '方案'}-${stamp}.pdf`
}

function addPdfSectionTitle(doc, title) {
  doc.moveDown(0.6)
  doc.fontSize(16).fillColor('#111827').text(title)
  doc.moveDown(0.2)
}

function addPdfMetaLine(doc, label, value) {
  const text = String(value || '').trim()

  if (!text) {
    return
  }

  doc.fontSize(11).fillColor('#111827').text(`${label}：${text}`, {
    lineGap: 4,
  })
}

function addPdfImagePage(doc, title, imageBuffer) {
  if (!imageBuffer || !imageBuffer.length) {
    return
  }

  doc.addPage()
  addPdfSectionTitle(doc, title)

  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const availableHeight = doc.page.height - doc.page.margins.top - doc.page.margins.bottom - 32

  doc.image(imageBuffer, doc.page.margins.left, doc.y + 12, {
    fit: [availableWidth, availableHeight],
    align: 'center',
    valign: 'center',
  })
}

function generateDesignPdfBuffer(payload) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 46,
      bufferPages: true,
      autoFirstPage: true,
    })
    const chunks = []
    const pdfFontPath = resolvePdfFontPath()
    const exportedAt = String(payload.exportedAt || '').trim() || new Date().toLocaleString('zh-CN', { hour12: false })
    const designText = sanitizeMarkdownForPdf(payload.designText)
    const selectedFurnitureLabels = normalizeStringArray(payload.selectedFurnitureLabels)

    doc.on('data', (chunk) => {
      chunks.push(chunk)
    })
    doc.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    doc.on('error', reject)

    if (pdfFontPath) {
      doc.font(pdfFontPath)
    }

    doc.info.Title = '微光空间方案详情'
    doc.info.Author = '微光空间'
    doc.info.Subject = '空间改造方案导出'
    doc.info.CreationDate = new Date()

    doc.fontSize(22).fillColor('#111827').text('微光空间 AI 改造方案', {
      align: 'center',
    })
    doc.moveDown(0.4)
    doc.fontSize(11).fillColor('#475569').text('方案详情与导出页', {
      align: 'center',
    })
    doc.moveDown(0.6)
    doc.fontSize(10).fillColor('#64748b').text(`导出时间：${exportedAt}`, {
      align: 'center',
    })

    addPdfSectionTitle(doc, '项目概览')
    addPdfMetaLine(doc, '服务人群', payload.servicePeople)
    addPdfMetaLine(doc, '空间类型', payload.spaceType)
    addPdfMetaLine(doc, '空间面积', payload.areaText)
    addPdfMetaLine(doc, '预算范围', payload.budgetRange)
    addPdfMetaLine(doc, '重点家具', selectedFurnitureLabels.join('、'))
    addPdfMetaLine(doc, '核心诉求', payload.coreNeeds)
    addPdfMetaLine(doc, '约束条件', payload.constraints)

    if (designText) {
      addPdfSectionTitle(doc, '智能设计说明')
      doc.fontSize(11).fillColor('#334155').text(designText, {
        lineGap: 5,
      })
    } else {
      addPdfSectionTitle(doc, '智能设计说明')
      doc.fontSize(11).fillColor('#64748b').text(
        '本次导出时暂无智能设计说明，PDF 先保留已生成的方案图片。可回到小程序继续生成或稍后补充说明。',
        {
          lineGap: 5,
        }
      )
    }

    const floorPlanImage = getCachedImageById(payload.floorPlanImageId)
    const renderImageIds = Array.isArray(payload.renderImageIds)
      ? payload.renderImageIds.filter((item) => typeof item === 'string' && item.trim())
      : []
    const resolvedRenderImageIds = renderImageIds.length
      ? renderImageIds
      : String(payload.renderImageId || '').trim()
        ? [String(payload.renderImageId || '').trim()]
        : []

    if (floorPlanImage && /^image\/(png|jpeg|jpg)$/i.test(floorPlanImage.mimeType)) {
      addPdfImagePage(doc, '2D 布局图', floorPlanImage.buffer)
    }

    resolvedRenderImageIds.forEach((imageId, index) => {
      const renderImage = getCachedImageById(imageId)

      if (!renderImage || !/^image\/(png|jpeg|jpg)$/i.test(renderImage.mimeType)) {
        return
      }

      addPdfImagePage(
        doc,
        resolvedRenderImageIds.length > 1
          ? `3D 效果图（视角 ${index + 1}）`
          : '3D 效果图',
        renderImage.buffer
      )
    })

    doc.end()
  })
}

function pruneTaskCache() {
  while (TASK_CACHE.size > MAX_TASK_CACHE_SIZE) {
    const oldestKey = TASK_CACHE.keys().next().value
    TASK_CACHE.delete(oldestKey)
  }
}

function clampPrimaryViewIndex(primaryViewIndex, uploadedFiles) {
  const maxIndex = Array.isArray(uploadedFiles) ? uploadedFiles.length - 1 : -1

  if (maxIndex < 0) {
    return 0
  }

  const numeric = Number(primaryViewIndex)

  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0
  }

  return Math.min(maxIndex, Math.floor(numeric))
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

function createTask({ publicBaseUrl, body }) {
  const taskId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const task = {
    taskId,
    status: 'queued',
    progressPercent: 2,
    progressTitle: '任务已创建',
    progressHint: '图片上传成功，准备开始分析空间',
    error: '',
    publicBaseUrl,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    body: {
      ...body,
    },
    result: null,
  }

  TASK_CACHE.set(taskId, task)
  pruneTaskCache()
  return task
}

function updateTask(taskId, patch) {
  const currentTask = TASK_CACHE.get(taskId)

  if (!currentTask) {
    return null
  }

  const nextTask = {
    ...currentTask,
    ...patch,
    updatedAt: Date.now(),
  }
  TASK_CACHE.set(taskId, nextTask)
  return nextTask
}

function getTaskResponse(task) {
  return {
    ok: true,
    taskId: task.taskId,
    status: task.status,
    progressPercent: task.progressPercent,
    progressTitle: task.progressTitle,
    progressHint: task.progressHint,
    error: task.error,
    result: task.result,
  }
}

function parseSelectedFurnitureIds(value) {
  if (Array.isArray(value)) {
    return value
  }

  if (typeof value !== 'string' || !value.trim()) {
    return []
  }

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch (error) {
    return []
  }
}

function formatSelectedFurnitureLabels(value) {
  const labelMap = {}

  FURNITURE_LIBRARY.forEach((item) => {
    if (item && item.id) {
      labelMap[item.id] = item.label || item.id
    }
  })

  return parseSelectedFurnitureIds(value).map((id) => labelMap[id] || id)
}

function formatSelectedFurnitureStyleLabels(value) {
  const labelMap = {}

  flattenFurnitureStyleItems().forEach((item) => {
    if (item && item.id) {
      labelMap[item.id] = `${item.furnitureLabel || ''}${item.label ? `-${item.label}` : ''}`
    }
  })

  return parseSelectedFurnitureIds(value).map((id) => labelMap[id] || id)
}

function buildTaskDesignPrompt(body, extraContext) {
  const selectedFurnitureLabels = formatSelectedFurnitureLabels(body.selectedFurnitureIds)
  const mustHaveText =
    selectedFurnitureLabels.length > 0 ? selectedFurnitureLabels.join('、') : '基础休息与收纳设施'
  const selectedStyleLabels = formatSelectedFurnitureStyleLabels(body.selectedFurnitureStyleIds)
  const furnitureStyleText =
    String(body.furnitureStyleText || '').trim() ||
    (selectedStyleLabels.length ? selectedStyleLabels.join('、') : '')

  return [
    '你是一位擅长公益空间改造的室内设计师，请基于以下信息输出中文设计说明。',
    '',
    '项目背景：',
    `- 服务人群：${body.servicePeople || '未填写'}`,
    `- 空间类型：${body.spaceType || '未填写'}`,
    `- 大致面积：${body.areaText || '未填写'}`,
    `- 预算范围：${body.budgetRange || '未填写'}`,
    `- 核心诉求：${body.coreNeeds || '未填写'}`,
    `- 约束条件：${body.constraints || '未填写'}`,
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
    '- 语言温暖、专业、克制，不要夸张宣传。',
    '- 强调对基层劳动者友好、易清洁、易维护、便于休息。',
    '- 不能编造超大面积、昂贵材料或复杂施工。',
    '',
    '补充上下文：',
    extraContext || '无',
  ].join('\n')
}

function parseEditedItems(value) {
  if (Array.isArray(value)) {
    return value
  }

  if (typeof value !== 'string' || !value.trim()) {
    return []
  }

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch (error) {
    return []
  }
}

function buildFinalDesignPrompt(body) {
  const editedItems = parseEditedItems(body.editedItems)
  const placements = editedItems.length
    ? editedItems
        .map((item, index) => {
          const label =
            typeof item.label === 'string' && item.label.trim() ? item.label.trim() : `家具${index + 1}`
          const scene = typeof item.sceneLabel === 'string' && item.sceneLabel.trim() ? item.sceneLabel.trim() : ''
          const x = Number(item.xPercent)
          const y = Number(item.yPercent)
          const scale = Number(item.scale)
          const parts = [
            `${index + 1}. ${label}`,
            scene ? `所在图层：${scene}` : '',
            Number.isFinite(x) && Number.isFinite(y) ? `位置：横向 ${x}% / 纵向 ${y}%` : '',
            Number.isFinite(scale) ? `缩放：${scale}` : '',
            typeof item.promptHint === 'string' && item.promptHint.trim() ? `用途：${item.promptHint.trim()}` : '',
          ].filter(Boolean)

          return parts.join('；')
        })
        .join('\n')
    : '当前没有手动新增家具，请以 AI 初稿为准。'

  return [
    '你是一位擅长公益空间改造的室内设计师，请根据当前最终编辑结果输出中文方案说明。',
    '',
    '项目背景：',
    `- 服务人群：${body.servicePeople || '未填写'}`,
    `- 空间类型：${body.spaceType || '未填写'}`,
    `- 大致面积：${body.areaText || '未填写'}`,
    `- 预算范围：${body.budgetRange || '未填写'}`,
    `- 核心诉求：${body.coreNeeds || '未填写'}`,
    `- 约束条件：${body.constraints || '未填写'}`,
    `- 当前编辑图层：${body.activeSceneLabel || body.activeScene || '未填写'}`,
    '',
    '人工微调后的家具布置：',
    placements,
    '',
    '已有 AI 初稿说明：',
    body.existingDesignText || '无',
    '',
    '请输出 4 个部分，并使用清晰的小标题：',
    '1. 最终方案定位：一句话概括最终编辑版方案的特点。',
    '2. 布局与家具说明：结合手动拖拽后的家具布置，说明各分区与动线。',
    '3. 改造建议：给出 3-5 条低成本、可施工、可维护的建议。',
    '4. 采购参考清单：按“物品 - 作用 - 是否建议优先采购”格式输出。',
    '',
    '要求：',
    '- 只使用中文输出。',
    '- 明确体现人工微调后的最终方案，不要只重复初稿。',
    '- 强调基层劳动者友好、易清洁、易维护、可落地。',
    '- 不得虚构超大面积、昂贵材料或复杂施工。',
  ].join('\n')
}

/**
 * 调用 Gemini 原生接口。
 *
 * @param {Object} params 参数对象。
 * @param {string} params.requestId 请求 ID。
 * @param {string} params.baseUrl 上游基础地址。
 * @param {string} params.apiKey 上游 API Key。
 * @param {string} params.model 模型名称。
 * @param {Object} params.body 请求体。
 * @param {number} params.timeoutMs 超时时间。
 * @returns {Promise<Object>} 上游响应 JSON。
 *
 * 使用示例：
 * `await requestGeminiNative({ requestId, baseUrl, apiKey, model, body, timeoutMs })`
 */
async function requestGeminiNative({ requestId, baseUrl, apiKey, model, body, timeoutMs }) {
  const url = buildNativeUrl({ baseUrl, apiKey, model })
  const maxAttempts = 3
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now()

    log('info', requestId, '开始请求上游 Gemini 接口', {
      model,
      timeoutMs,
      attempt,
      url: url.replace(apiKey, '***'),
    })

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })

      const rawText = await response.text()
      let parsed

      try {
        parsed = rawText ? JSON.parse(rawText) : {}
      } catch (error) {
        throw new Error(`上游返回了非 JSON 响应。status=${response.status} detail=${rawText.slice(0, 500)}`)
      }

      if (response.ok) {
        log('info', requestId, '上游 Gemini 接口请求成功', {
          model,
          attempt,
          elapsedMs: Date.now() - startedAt,
        })

        return parsed
      }

      lastError = new Error(`上游请求失败。status=${response.status} detail=${JSON.stringify(parsed).slice(0, 1000)}`)
      const shouldRetry = response.status === 429 || response.status >= 500

      log('error', requestId, '上游 Gemini 接口请求失败', {
        model,
        attempt,
        elapsedMs: Date.now() - startedAt,
        status: response.status,
        detail: parsed,
      })

      if (!shouldRetry || attempt >= maxAttempts) {
        throw lastError
      }
    } catch (error) {
      const causeMessage =
        error && error.cause && error.cause.message ? error.cause.message : ''
      const canRetryNetworkError =
        error && error.name !== 'Error'
          ? true
          : typeof error?.message === 'string' &&
            (error.message === 'fetch failed' || error.message.indexOf('timed out') >= 0)

      lastError =
        error instanceof Error
          ? error
          : new Error(typeof error === 'string' ? error : '上游请求失败。')

      log('error', requestId, '上游 Gemini 接口请求异常', {
        model,
        attempt,
        elapsedMs: Date.now() - startedAt,
        error: lastError.message,
        cause: causeMessage,
      })

      if (!canRetryNetworkError || attempt >= maxAttempts) {
        if (causeMessage && lastError.message === 'fetch failed') {
          throw new Error(`上游请求失败。detail=${causeMessage}`)
        }

        throw lastError
      }
    }

    await sleep(attempt * 3000)
  }

  throw lastError || new Error('上游请求失败。')
}

async function requestOpenAIJson({
  requestId,
  baseUrl,
  apiKey,
  path,
  body,
  timeoutMs,
  model,
}) {
  const url = buildOpenAIUrl({ baseUrl, path })
  const startedAt = Date.now()

  log('info', requestId, '开始请求上游 OpenAI 兼容 JSON 接口', {
    model,
    timeoutMs,
    path,
    url,
  })

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })

  const rawText = await response.text()
  let parsed

  try {
    parsed = rawText ? JSON.parse(rawText) : {}
  } catch (error) {
    throw new Error(`上游返回了非 JSON 响应。status=${response.status} detail=${rawText.slice(0, 500)}`)
  }

  if (!response.ok) {
    throw new Error(`上游请求失败。status=${response.status} detail=${JSON.stringify(parsed).slice(0, 1000)}`)
  }

  log('info', requestId, '上游 OpenAI 兼容 JSON 接口请求成功', {
    model,
    path,
    elapsedMs: Date.now() - startedAt,
  })

  return parsed
}

async function requestOpenAIFormData({
  requestId,
  baseUrl,
  apiKey,
  path,
  formData,
  timeoutMs,
  model,
}) {
  const url = buildOpenAIUrl({ baseUrl, path })
  const maxAttempts = 3
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now()

    log('info', requestId, '开始请求上游 OpenAI 兼容表单接口', {
      model,
      timeoutMs,
      path,
      url,
      attempt,
    })

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(timeoutMs),
    })

    const rawText = await response.text()
    let parsed

    try {
      parsed = rawText ? JSON.parse(rawText) : {}
    } catch (error) {
      throw new Error(`上游返回了非 JSON 响应。status=${response.status} detail=${rawText.slice(0, 500)}`)
    }

    if (response.ok) {
      log('info', requestId, '上游 OpenAI 兼容表单接口请求成功', {
        model,
        path,
        attempt,
        elapsedMs: Date.now() - startedAt,
      })

      return parsed
    }

    lastError = new Error(`上游请求失败。status=${response.status} detail=${JSON.stringify(parsed).slice(0, 1000)}`)
    const errorCode = String(parsed?.error?.code || '')
    const shouldRetry = response.status === 429 || errorCode === 'RateLimitReached'

    log('error', requestId, '上游 OpenAI 兼容表单接口请求失败', {
      model,
      path,
      attempt,
      elapsedMs: Date.now() - startedAt,
      status: response.status,
      errorCode,
      detail: parsed,
    })

    if (!shouldRetry || attempt >= maxAttempts) {
      throw lastError
    }

    await sleep(attempt * 3000)
  }

  throw lastError || new Error('上游请求失败。')
}

async function requestAiGatewayJson({
  requestId,
  baseUrl,
  path,
  body,
  timeoutMs,
  maxAttempts = 3,
  fallbackModels = [],
  fallbackMaxAttempts = 1,
  bodyFactory,
}) {
  const url = `${normalizeBaseUrl(baseUrl)}${String(path || '').startsWith('/') ? path : `/${path}`}`
  let lastError = null
  const primaryModel = String((body && body.model) || '').trim()
  const modelQueue = [primaryModel]

  fallbackModels.forEach((item) => {
    const fallbackModel = String(item || '').trim()

    if (fallbackModel && modelQueue.indexOf(fallbackModel) < 0) {
      modelQueue.push(fallbackModel)
    }
  })

  for (let modelIndex = 0; modelIndex < modelQueue.length; modelIndex += 1) {
    const activeModel = modelQueue[modelIndex]
    const attemptsForModel = modelIndex === 0 ? maxAttempts : fallbackMaxAttempts

    for (let attempt = 1; attempt <= attemptsForModel; attempt += 1) {
      const startedAt = Date.now()
      const requestBody =
        typeof bodyFactory === 'function'
          ? bodyFactory(activeModel)
          : {
              ...(body || {}),
              model: activeModel || (body && body.model),
            }

      log('info', requestId, '开始请求统一 AI 网关', {
        path,
        model: requestBody && requestBody.model,
        timeoutMs,
        attempt,
        modelAttempt: `${modelIndex + 1}/${modelQueue.length}`,
        fallbackFromModel: modelIndex > 0 ? primaryModel : '',
        url,
      })

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody || {}),
          signal: AbortSignal.timeout(timeoutMs),
        })

        const rawText = await response.text()
        let parsed

        try {
          parsed = rawText ? JSON.parse(rawText) : {}
        } catch (error) {
          throw new Error(`统一 AI 网关返回了非 JSON 响应。status=${response.status} detail=${rawText.slice(0, 500)}`)
        }

        if (!response.ok || !parsed.ok) {
          const detail = parsed && parsed.error ? parsed.error : JSON.stringify(parsed).slice(0, 1000)
          const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail)
          const canRetryThisModel =
            response.status === 429 ||
            response.status >= 502 ||
            /status=429|upstream load is saturated|RateLimit|timeout|timed out/i.test(detailText)
          const shouldRetry =
            canRetryThisModel &&
            (attempt < attemptsForModel || modelIndex + 1 < modelQueue.length)

          lastError = new Error(`统一 AI 网关请求失败。status=${response.status} detail=${detail}`)
          log('error', requestId, '统一 AI 网关请求失败', {
            path,
            model: requestBody && requestBody.model,
            attempt,
            modelAttempt: `${modelIndex + 1}/${modelQueue.length}`,
            fallbackFromModel: modelIndex > 0 ? primaryModel : '',
            elapsedMs: Date.now() - startedAt,
            status: response.status,
            detail,
            shouldRetry,
          })

          if (!shouldRetry) {
            throw lastError
          }

          if (attempt < attemptsForModel) {
            await sleep(attempt * 12000)
            continue
          }
          break
        }

        log('info', requestId, '统一 AI 网关请求成功', {
          path,
          model: requestBody && requestBody.model,
          attempt,
          modelAttempt: `${modelIndex + 1}/${modelQueue.length}`,
          fallbackFromModel: modelIndex > 0 ? primaryModel : '',
          elapsedMs: Date.now() - startedAt,
        })

        return parsed.data || {}
      } catch (error) {
        const message = error && error.message ? error.message : String(error || '')
        const canRetryThisModel = /fetch failed|timeout|timed out|aborted|upstream load is saturated|status=429/i.test(message)
        const shouldRetry =
          canRetryThisModel &&
          (attempt < attemptsForModel || modelIndex + 1 < modelQueue.length)

        lastError = error
        log('error', requestId, '统一 AI 网关请求异常', {
          path,
          model: requestBody && requestBody.model,
          attempt,
          modelAttempt: `${modelIndex + 1}/${modelQueue.length}`,
          fallbackFromModel: modelIndex > 0 ? primaryModel : '',
          elapsedMs: Date.now() - startedAt,
          error: message,
          shouldRetry,
        })

        if (!shouldRetry) {
          throw error
        }

        if (attempt < attemptsForModel) {
          await sleep(attempt * 12000)
          continue
        }
        break
      }
    }
  }

  throw lastError || new Error('统一 AI 网关请求失败。')
}

function parseGatewayImageResponse(response) {
  return {
    imageBase64: typeof response?.imageBase64 === 'string' ? response.imageBase64.trim() : '',
    imageMimeType: typeof response?.mimeType === 'string' ? response.mimeType.trim() : 'image/png',
    text: typeof response?.text === 'string' ? response.text.trim() : '',
  }
}

function mapGatewayImageQuality(imageSize) {
  const value = String(imageSize || '').trim().toUpperCase()

  if (value === '2K') {
    return 'high'
  }

  return 'medium'
}

/**
 * 构造图像生成请求体。
 *
 * @param {Object} params 参数对象。
 * @param {string} params.prompt 提示词。
 * @param {string} params.imageBase64 输入图片 base64。
 * @param {string} params.mimeType 输入图片类型。
 * @param {string} params.aspectRatio 输出比例。
 * @param {string} params.imageSize 输出尺寸。
 * @returns {Object} Gemini 请求体。
 *
 * 使用示例：
 * `buildImageEditBody({ prompt, imageBase64, mimeType, aspectRatio: '4:3', imageSize: '1K' })`
 */
function buildImageEditBody({ prompt, imageBase64, mimeType, aspectRatio, imageSize }) {
  return {
    contents: [
      {
        parts: [
          {
            text: prompt,
          },
          {
            inline_data: {
              mime_type: mimeType || 'image/jpeg',
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: aspectRatio || '4:3',
        imageSize: imageSize || '1K',
      },
    },
  }
}

function buildMultiImageEditBody({ prompt, images, aspectRatio, imageSize }) {
  const parts = [
    {
      text: prompt,
    },
  ]

  ;(images || []).forEach((image) => {
    if (!image || !image.data) {
      return
    }

    parts.push({
      inline_data: {
        mime_type: image.mimeType || 'image/jpeg',
        data: image.data,
      },
    })
  })

  return {
    contents: [
      {
        parts,
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: aspectRatio || '4:3',
        imageSize: imageSize || '1K',
      },
    },
  }
}

function collectUploadedGeminiImages(body) {
  const images = []

  if (Array.isArray(body.uploadedFiles) && body.uploadedFiles.length > 0) {
    body.uploadedFiles.forEach((entry) => {
      if (!entry || !entry.buffer || !Buffer.isBuffer(entry.buffer) || !entry.buffer.length) {
        return
      }

      images.push({
        mimeType: entry.mimeType || 'image/jpeg',
        data: entry.buffer.toString('base64'),
      })
    })
  }

  if (!images.length && body.fileBuffer && Buffer.isBuffer(body.fileBuffer) && body.fileBuffer.length) {
    images.push({
      mimeType:
        typeof body.mimeType === 'string' && body.mimeType.trim()
          ? body.mimeType.trim()
          : 'image/jpeg',
      data: body.fileBuffer.toString('base64'),
    })
  }

  return images
}

function collectFurnitureReferenceImages(body) {
  const images = []
  const styleMap = {}

  flattenFurnitureStyleItems().forEach((item) => {
    if (item && item.id) {
      styleMap[item.id] = item
    }
  })

  parseSelectedFurnitureIds(body.selectedFurnitureStyleIds).forEach((styleId) => {
    const styleItem = styleMap[styleId]

    if (!styleItem || !styleItem.imagePath) {
      return
    }

    const absolutePath = resolveFurnitureStyleAssetPath(styleItem.imagePath)

    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return
    }

    images.push({
      mimeType: inferMimeTypeFromFileName(absolutePath),
      data: fs.readFileSync(absolutePath).toString('base64'),
      fileName: `${styleItem.id}.jpg`,
    })
  })

  parseExtraImagesJsonField(body.furnitureReferenceImagesJson).forEach((item, index) => {
    if (!item || typeof item.data !== 'string' || !item.data.trim()) {
      return
    }

    images.push({
      mimeType:
        typeof item.mimeType === 'string' && item.mimeType.trim()
          ? item.mimeType.trim()
          : inferImageMimeTypeFromBase64(item.data),
      data: item.data.trim(),
      fileName: `custom-furniture-${index + 1}.jpg`,
    })
  })

  return images.slice(0, 8)
}

/**
 * 构造文本生成请求体。
 *
 * @param {Object} params 参数对象。
 * @param {string} params.prompt 提示词。
 * @returns {Object} Gemini 请求体。
 *
 * 使用示例：
 * `buildTextBody({ prompt: '请输出中文设计说明' })`
 */
function buildTextBody({ prompt }) {
  return {
    contents: [
      {
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT'],
    },
  }
}

function appendOpenAIImage(formData, name, image, index) {
  if (!image || !image.data) {
    return
  }

  const mimeType = image.mimeType || 'image/jpeg'
  const extension = mimeType.indexOf('png') >= 0 ? 'png' : mimeType.indexOf('webp') >= 0 ? 'webp' : 'jpg'
  const fileName = image.fileName || `input-${index + 1}.${extension}`
  const blob = new Blob([Buffer.from(image.data, 'base64')], { type: mimeType })

  formData.append(name, blob, fileName)
}

/**
 * 读取服务配置。
 *
 * @returns {Object} 当前服务配置。
 *
 * 使用示例：
 * `const config = getConfig()`
 */
function getConfig() {
  const aiGatewayBaseUrl = getEnvString('AI_GATEWAY_BASE_URL', DEFAULT_AI_GATEWAY_BASE_URL)
  const visionBaseUrl = getEnvString('VISION_BASE_URL', DEFAULT_BASE_URL)
  const visionApiKey = getEnvString('VISION_API_KEY', DEFAULT_API_KEY)
  const visionModel = getEnvString('VISION_MODEL', DEFAULT_VISION_MODEL)
  const textBaseUrl = getEnvString('TEXT_BASE_URL', visionBaseUrl)
  const textApiKey = getEnvString('TEXT_API_KEY', visionApiKey)
  const textModel = getEnvString('TEXT_MODEL', DEFAULT_TEXT_MODEL)

  return {
    host: getEnvString('HOST', '127.0.0.1'),
    port: getEnvNumber('PORT', 3000),
    publicBasePath: getEnvString('PUBLIC_BASE_PATH', ''),
    timeoutMs: getEnvNumber('REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    aiGatewayBaseUrl,
    visionBaseUrl,
    visionApiKey,
    visionModel,
    textBaseUrl,
    textApiKey,
    textModel,
  }
}

/**
 * 处理图像生成接口。
 *
 * @param {Object} params 参数对象。
 * @param {string} params.requestId 请求 ID。
 * @param {Object} params.body 请求体。
 * @param {Object} params.config 服务配置。
 * @returns {Promise<Object>} 返回给前端的对象。
 *
 * 使用示例：
 * `await handleImageGeneration({ requestId, body, config })`
 */
async function handleImageGeneration({ requestId, body, config }) {
  const prompt = requireString(body, 'prompt')
  const model = selectRequestedModel(body.model, config.visionModel)
  const aspectRatio = typeof body.aspectRatio === 'string' ? body.aspectRatio : '4:3'
  const imageSize = typeof body.imageSize === 'string' ? body.imageSize : '1K'
  const images = []
  const imageBase64 =
    typeof body.imageBase64 === 'string' && body.imageBase64.trim()
      ? body.imageBase64.trim()
      : ''
  const mimeType =
    typeof body.mimeType === 'string' && body.mimeType.trim()
      ? body.mimeType.trim()
      : ''

  if (imageBase64) {
    if (!mimeType) {
      throw new Error('缺少必要字段：mimeType。')
    }

    images.push({
      data: imageBase64,
      mimeType,
      fileName: typeof body.fileName === 'string' ? body.fileName : 'input-1.jpg',
    })
  }

  collectUploadedGeminiImages(body).forEach((image, index) => {
    images.push({
      ...image,
      fileName: image.fileName || `input-${index + 1}.jpg`,
    })
  })

  if (typeof body.imageId === 'string' && body.imageId.trim()) {
    const cachedImage = getCachedImageById(body.imageId.trim())

    if (cachedImage) {
      images.push({
        mimeType: cachedImage.mimeType,
        data: cachedImage.buffer.toString('base64'),
        fileName: 'cached-image.png',
      })
    }
  }

  if (String(body.includeFurnitureReferences || '').trim() !== 'false') {
    collectFurnitureReferenceImages(body).forEach((image) => {
      images.push(image)
    })
  }

  if (!images.length) {
    throw new Error('缺少必要字段：imageBase64 或上传文件。')
  }

  const response = await requestAiGatewayJson({
    requestId,
    baseUrl: config.aiGatewayBaseUrl,
    path: '/v1/images/edit',
    timeoutMs: config.timeoutMs,
    maxAttempts: 2,
    fallbackModels: getImageFallbackModels(model),
    fallbackMaxAttempts: 1,
    bodyFactory: (activeModel) =>
      buildGatewayImageEditBody({
        model: activeModel,
        prompt,
        aspectRatio,
        imageSize,
        images,
      }),
    body: buildGatewayImageEditBody({
      model,
      prompt,
      aspectRatio,
      imageSize,
      images,
    }),
  })

  return parseGatewayImageResponse(response)
}

async function handleRenderGeneration({ requestId, body, config }) {
  const prompt = requireString(body, 'prompt')
  const model = selectRequestedModel(body.model, config.visionModel)
  const aspectRatio = typeof body.aspectRatio === 'string' ? body.aspectRatio : '4:3'
  const imageSize = typeof body.imageSize === 'string' ? body.imageSize : '1K'
  const images = []
  const imageBase64 =
    typeof body.imageBase64 === 'string' && body.imageBase64.trim()
      ? body.imageBase64.trim()
      : ''
  const mimeType =
    typeof body.mimeType === 'string' && body.mimeType.trim()
      ? body.mimeType.trim()
      : ''

  if (imageBase64) {
    images.push({
      data: imageBase64,
      mimeType: mimeType || inferImageMimeTypeFromBase64(imageBase64),
      fileName: typeof body.fileName === 'string' ? body.fileName : 'input-1.jpg',
    })
  }

  collectUploadedGeminiImages(body).forEach((img) => {
    images.push(img)
  })

  if (typeof body.imageId === 'string' && body.imageId.trim()) {
    const cachedImage = getCachedImageById(body.imageId.trim())

    if (!cachedImage) {
      throw new Error(`未找到缓存图片。imageId=${body.imageId}`)
    }

    images.push({
      mimeType: cachedImage.mimeType,
      data: cachedImage.buffer.toString('base64'),
    })
  }

  if (String(body.includeFurnitureReferences || '').trim() !== 'false') {
    collectFurnitureReferenceImages(body).forEach((image) => {
      images.push(image)
    })
  }

  if (images.length < 1) {
    throw new Error('生成 3D 效果图时至少需要一张原始空间照片。')
  }

  const response = await requestAiGatewayJson({
    requestId,
    baseUrl: config.aiGatewayBaseUrl,
    path: '/v1/images/edit',
    timeoutMs: config.timeoutMs,
    maxAttempts: 2,
    fallbackModels: getImageFallbackModels(model),
    fallbackMaxAttempts: 1,
    bodyFactory: (activeModel) =>
      buildGatewayImageEditBody({
        model: activeModel,
        prompt,
        aspectRatio,
        imageSize,
        images,
      }),
    body: buildGatewayImageEditBody({
      model,
      prompt,
      aspectRatio,
      imageSize,
      images,
    }),
  })

  return parseGatewayImageResponse(response)
}

/**
 * 处理文本生成接口。
 *
 * @param {Object} params 参数对象。
 * @param {string} params.requestId 请求 ID。
 * @param {Object} params.body 请求体。
 * @param {Object} params.config 服务配置。
 * @returns {Promise<Object>} 返回给前端的对象。
 *
 * 使用示例：
 * `await handleTextGeneration({ requestId, body, config })`
 */
async function handleTextGeneration({ requestId, body, config }) {
  const prompt = requireString(body, 'prompt')
  const model = selectRequestedTextModel(body.model, config.textModel)
  const response = await requestAiGatewayJson({
    requestId,
    baseUrl: config.aiGatewayBaseUrl,
    path: '/v1/chat',
    timeoutMs: config.timeoutMs,
    body: {
      model,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
    },
  })

  return {
    text: typeof response.text === 'string' ? response.text.trim() : '',
  }
}

async function processTask(taskId, config) {
  const task = TASK_CACHE.get(taskId)

  if (!task) {
    return
  }

  const taskBody = task.body
  const uploadedFiles =
    Array.isArray(taskBody.uploadedFiles) && taskBody.uploadedFiles.length
      ? taskBody.uploadedFiles.filter(
          (item) => item && item.buffer && Buffer.isBuffer(item.buffer) && item.buffer.length
        )
      : taskBody.fileBuffer && Buffer.isBuffer(taskBody.fileBuffer) && taskBody.fileBuffer.length
        ? [
            {
              buffer: taskBody.fileBuffer,
              mimeType: taskBody.mimeType || 'image/jpeg',
            },
          ]
          : []
  const renderViewCount = Math.max(uploadedFiles.length, 1)
  const primaryViewIndex = clampPrimaryViewIndex(taskBody.primaryViewIndex, uploadedFiles)

  try {
    updateTask(taskId, {
      status: 'running',
      progressPercent: 12,
      progressTitle:
        renderViewCount > 1
          ? `正在优先生成 3D 效果图（1/${renderViewCount}）`
          : '正在优先生成 3D 效果图',
      progressHint: '3D 出图通常需要几分钟，请保持页面打开；效果图完成后会先显示，2D 布局图随后补齐',
    })

    const renderViews = []
    let primaryRenderView = null
    let primaryRenderText = ''

    for (let index = 0; index < renderViewCount; index += 1) {
      const primaryFile = uploadedFiles[index] || null
      const auxiliaryFiles = uploadedFiles.filter((_, fileIndex) => fileIndex !== index)
      const orderedFiles = primaryFile ? [primaryFile].concat(auxiliaryFiles) : []
      const isPrimaryView = index === primaryViewIndex
      const renderResult = await handleRenderGeneration({
        requestId: `${taskId}-render-${index + 1}`,
        body: {
          prompt: buildViewSpecificRenderPrompt(
            taskBody.renderPrompt,
            index,
            renderViewCount,
            isPrimaryView
          ),
          fileBuffer: primaryFile ? primaryFile.buffer : taskBody.fileBuffer,
          mimeType: primaryFile ? primaryFile.mimeType : taskBody.mimeType,
          uploadedFiles: orderedFiles.length ? orderedFiles : taskBody.uploadedFiles,
          model: taskBody.imageModel,
          aspectRatio: taskBody.aspectRatio,
          imageSize: taskBody.imageSize,
          selectedFurnitureStyleIds: taskBody.selectedFurnitureStyleIds,
          furnitureReferenceImagesJson: taskBody.furnitureReferenceImagesJson,
          furnitureStyleText: taskBody.furnitureStyleText,
        },
        config,
      })
      const renderCachedImage = cacheGeneratedImage({
        imageBase64: renderResult.imageBase64,
        imageMimeType: renderResult.imageMimeType,
      })
      const renderView = {
        sourceIndex: index,
        title: buildRenderViewTitle(index, renderViewCount, isPrimaryView),
        imageId: renderCachedImage.id,
        imageUrl: `${task.publicBaseUrl}/api/generated-image/${renderCachedImage.id}`,
        isPrimary: isPrimaryView,
      }

      renderViews.push(renderView)

      if (!primaryRenderView || isPrimaryView) {
        primaryRenderView = renderView
        primaryRenderText = renderResult.text || ''
      }

      updateTask(taskId, {
        status: 'running',
        progressPercent: 12 + Math.round(((index + 1) / renderViewCount) * 50),
        progressTitle:
          renderViewCount > 1
            ? index + 1 < renderViewCount
              ? `3D 效果图已生成 ${index + 1}/${renderViewCount}，正在继续出图`
              : '多视角 3D 效果图已生成，正在补充 2D 布局图'
            : '3D 效果图已生成，正在补充 2D 布局图',
        progressHint:
          renderViewCount > 1
            ? index + 1 < renderViewCount
              ? '已完成的 3D 图会先显示；剩余视角和 2D 布局图还在后台继续生成'
              : '所有 3D 视角已完成并可先查看，2D 布局图会随后补齐'
            : '已基于原始空间照片完成空间效果推演，2D 布局图会随后补齐',
        result: {
          ...(TASK_CACHE.get(taskId)?.result || {}),
          renderImageId: primaryRenderView ? primaryRenderView.imageId : '',
          renderImageUrl: primaryRenderView ? primaryRenderView.imageUrl : '',
          renderViews: renderViews.slice(),
          renderText: primaryRenderText,
          renderPrompt: taskBody.renderPrompt || '',
        },
      })
    }

    updateTask(taskId, {
      status: 'running',
      progressPercent: 68,
      progressTitle: '3D 效果图已显示，正在补充 2D 布局图',
      progressHint: '你可以先查看 3D 效果图；系统还在后台生成布局图和中文说明，请继续等待几分钟',
      result: {
        ...(TASK_CACHE.get(taskId)?.result || {}),
        renderImageId: primaryRenderView ? primaryRenderView.imageId : '',
        renderImageUrl: primaryRenderView ? primaryRenderView.imageUrl : '',
        renderViews,
        renderText: primaryRenderText,
        renderPrompt: taskBody.renderPrompt || '',
      },
    })

    let floorPlanResult = null
    let floorPlanCachedImage = null
    let floorPlanError = ''

    try {
      floorPlanResult = await handleImageGeneration({
        requestId: `${taskId}-floor`,
        body: {
          prompt: taskBody.floorPlanPrompt,
          fileBuffer: taskBody.fileBuffer,
          mimeType: taskBody.mimeType,
          uploadedFiles: taskBody.uploadedFiles,
          model: taskBody.imageModel,
          aspectRatio: taskBody.aspectRatio,
          imageSize: taskBody.imageSize,
          includeFurnitureReferences: 'false',
        },
        config,
      })
      floorPlanCachedImage = cacheGeneratedImage({
        imageBase64: floorPlanResult.imageBase64,
        imageMimeType: floorPlanResult.imageMimeType,
      })

      updateTask(taskId, {
        status: 'running',
        progressPercent: 86,
        progressTitle: '2D 布局图已生成，正在整理设计说明',
        progressHint: '核心图像已完成，正在生成可直接展示和导出的中文方案说明',
        result: {
          ...(TASK_CACHE.get(taskId)?.result || {}),
          floorPlanImageId: floorPlanCachedImage.id,
          floorPlanImageUrl: `${task.publicBaseUrl}/api/generated-image/${floorPlanCachedImage.id}`,
          floorPlanText: floorPlanResult.text || '',
          floorPlanPrompt: taskBody.floorPlanPrompt || '',
        },
      })
    } catch (error) {
      floorPlanError = error && error.message ? error.message : '2D 布局图生成失败。'
      updateTask(taskId, {
        status: 'running',
        progressPercent: 88,
        progressTitle: '3D 效果图已生成，2D 图纸稍后可重试',
        progressHint: '2D 图纸生成时上游繁忙，本次先保留 3D 效果图并继续整理中文说明',
        result: {
          ...(TASK_CACHE.get(taskId)?.result || {}),
          floorPlanPrompt: taskBody.floorPlanPrompt || '',
          floorPlanError,
        },
      })
    }

    const extraContext = [
      floorPlanResult && floorPlanResult.text ? `2D 模型说明：${floorPlanResult.text}` : '',
      primaryRenderText ? `3D 模型说明：${primaryRenderText}` : '',
      floorPlanError ? `补充说明：2D 布局图本次未能生成，原因是${floorPlanError}。请基于 3D 效果图和用户需求先整理可展示说明。` : '',
    ]
      .filter(Boolean)
      .join('\n')
    const designPrompt = buildTaskDesignPrompt(taskBody, extraContext)
    const designResult = await handleTextGeneration({
      requestId: `${taskId}-design`,
      body: {
        prompt: designPrompt,
        model: taskBody.textModel || config.textModel,
      },
      config,
    })

    updateTask(taskId, {
      status: 'completed',
      progressPercent: 100,
      progressTitle: floorPlanError ? '方案生成完成，2D 图纸稍后可重试' : '方案生成完成',
      progressHint: floorPlanError
        ? '3D 效果图和中文说明已完成；2D 图纸因上游繁忙暂未生成'
        : '可以查看布局图、效果图和中文设计说明了',
      result: {
        ...(TASK_CACHE.get(taskId)?.result || {}),
        floorPlanImageId: floorPlanCachedImage ? floorPlanCachedImage.id : '',
        floorPlanImageUrl: floorPlanCachedImage
          ? `${task.publicBaseUrl}/api/generated-image/${floorPlanCachedImage.id}`
          : '',
        floorPlanText: floorPlanResult ? floorPlanResult.text || '' : '',
        floorPlanError,
        renderImageId: primaryRenderView ? primaryRenderView.imageId : '',
        renderImageUrl: primaryRenderView ? primaryRenderView.imageUrl : '',
        renderViews,
        renderText: primaryRenderText,
        designText: designResult.text || '',
        floorPlanPrompt: taskBody.floorPlanPrompt || '',
        renderPrompt: taskBody.renderPrompt || '',
        designPrompt,
      },
    })
  } catch (error) {
    updateTask(taskId, {
      status: 'failed',
      progressPercent: 0,
      progressTitle: '方案生成失败',
      progressHint: '',
      error: error && error.message ? error.message : '未知错误',
    })
  }
}

/**
 * 主路由处理。
 *
 * @param {http.IncomingMessage} req Node 请求对象。
 * @param {http.ServerResponse} res Node 响应对象。
 * @returns {Promise<void>} 无返回值。
 *
 * 使用示例：
 * 由 `http.createServer()` 自动调用。
 */
async function handleRequest(req, res) {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const startedAt = Date.now()
  const config = getConfig()
  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)

  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true })
    return
  }

  try {
    log('info', requestId, '收到请求', {
      method: req.method,
      path: parsedUrl.pathname,
    })

    if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'weiguang-space-server',
        time: new Date().toISOString(),
        config: {
          host: config.host,
          port: config.port,
          timeoutMs: config.timeoutMs,
          aiGatewayBaseUrl: config.aiGatewayBaseUrl,
          visionBaseUrl: config.visionBaseUrl,
          visionModel: config.visionModel,
          textBaseUrl: config.textBaseUrl,
          textModel: config.textModel,
          hasVisionApiKey: Boolean(config.visionApiKey),
          hasTextApiKey: Boolean(config.textApiKey),
        },
      })
      return
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/library/furniture') {
      sendJson(res, 200, {
        ok: true,
        items: FURNITURE_LIBRARY,
      })
      return
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/library/furniture-styles') {
      sendJson(res, 200, {
        ok: true,
        groups: buildFurnitureStyleLibraryResponse(buildPublicBaseUrl(req, config)),
      })
      return
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/api/library/cases') {
      sendJson(res, 200, {
        ok: true,
        items: buildCaseLibraryResponse(buildPublicBaseUrl(req, config)),
      })
      return
    }

    if (req.method === 'GET' && parsedUrl.pathname.indexOf('/api/library/cases/') === 0) {
      const caseId = decodeURIComponent(parsedUrl.pathname.replace('/api/library/cases/', ''))
      const caseItem = findCaseLibraryItem(caseId)

      if (!caseItem) {
        sendJson(res, 404, {
          ok: false,
          error: {
            message: '未找到该案例。',
          },
        })
        return
      }

      sendJson(res, 200, {
        ok: true,
        item: buildCaseLibraryItem(buildPublicBaseUrl(req, config), caseItem, {
          detail: true,
        }),
      })
      return
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && parsedUrl.pathname.indexOf('/api/case-image/') === 0) {
      const relativePath = decodeURIComponent(parsedUrl.pathname.replace('/api/case-image/', ''))
      const absolutePath = resolveCaseAssetPath(relativePath)

      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        sendJson(res, 404, {
          ok: false,
          error: `未找到案例素材。path=${relativePath}`,
        })
        return
      }

      const stat = fs.statSync(absolutePath)
      const mimeType = inferMimeTypeFromFileName(absolutePath)

      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Length': stat.size,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        })
        res.end()
        return
      }

      sendBinary(res, 200, fs.readFileSync(absolutePath), mimeType, {
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      return
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && parsedUrl.pathname.indexOf('/api/furniture-style-image/') === 0) {
      const relativePath = decodeURIComponent(
        parsedUrl.pathname.replace('/api/furniture-style-image/', '')
      )
      const absolutePath = resolveFurnitureStyleAssetPath(relativePath)

      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        sendJson(res, 404, {
          ok: false,
          error: `未找到家具款式素材。path=${relativePath}`,
        })
        return
      }

      const stat = fs.statSync(absolutePath)
      const mimeType = inferMimeTypeFromFileName(absolutePath)

      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Length': stat.size,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        })
        res.end()
        return
      }

      sendBinary(res, 200, fs.readFileSync(absolutePath), mimeType, {
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      return
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && parsedUrl.pathname.indexOf('/api/generated-image/') === 0) {
      const imageId = decodeURIComponent(parsedUrl.pathname.replace('/api/generated-image/', ''))
      const cachedImage = getCachedImageById(imageId)

      if (!cachedImage) {
        sendJson(res, 404, {
          ok: false,
          error: `未找到缓存图片。imageId=${imageId}`,
        })
        return
      }

      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': cachedImage.mimeType,
          'Content-Length': cachedImage.buffer.length,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        })
        res.end()
        return
      }

      sendBinary(res, 200, cachedImage.buffer, cachedImage.mimeType, {
        'Content-Length': cachedImage.buffer.length,
      })
      return
    }

    if (req.method === 'GET' && parsedUrl.pathname.indexOf('/api/generated-file/') === 0) {
      const fileId = decodeURIComponent(parsedUrl.pathname.replace('/api/generated-file/', ''))
      const cachedFile = GENERATED_FILE_CACHE.get(fileId)

      if (!cachedFile) {
        sendJson(res, 404, {
          ok: false,
          error: `未找到缓存文件。fileId=${fileId}`,
        })
        return
      }

      sendBinary(res, 200, cachedFile.buffer, cachedFile.mimeType, {
        'Content-Disposition': `inline; filename="${encodeURIComponent(cachedFile.fileName || 'weiguang-space-design.pdf')}"`,
      })
      return
    }

    if (req.method === 'GET' && parsedUrl.pathname.indexOf('/api/shared-plan/') === 0) {
      const shareId = decodeURIComponent(parsedUrl.pathname.replace('/api/shared-plan/', ''))
      const sharedPlan = SHARED_PLAN_CACHE.get(shareId)

      if (!sharedPlan) {
        sendJson(res, 404, {
          ok: false,
          error: `未找到分享方案。shareId=${shareId}`,
        })
        return
      }

      sendJson(res, 200, {
        ok: true,
        shareId,
        plan: sharedPlan.plan || {},
      })
      return
    }

    if (req.method === 'GET' && parsedUrl.pathname.indexOf('/api/tasks/') === 0) {
      const taskId = decodeURIComponent(parsedUrl.pathname.replace('/api/tasks/', ''))
      const task = TASK_CACHE.get(taskId)

      if (!task) {
        sendJson(res, 404, {
          ok: false,
          error: `未找到任务。taskId=${taskId}`,
        })
        return
      }

      sendJson(res, 200, getTaskResponse(task))
      return
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/tasks/create') {
      const body = normalizeJsonImageUploads(await readRequestBody(req))

      const hasUpload =
        (body.fileBuffer && Buffer.isBuffer(body.fileBuffer) && body.fileBuffer.length > 0) ||
        (Array.isArray(body.uploadedFiles) &&
          body.uploadedFiles.some(
            (item) => item && item.buffer && Buffer.isBuffer(item.buffer) && item.buffer.length > 0
          ))

      if (!hasUpload) {
        throw new Error('创建任务失败：缺少原始空间图片。')
      }

      const task = createTask({
        publicBaseUrl: buildPublicBaseUrl(req, config),
        body: {
          ...body,
        },
      })

      setImmediate(() => {
        processTask(task.taskId, config)
      })

      sendJson(res, 200, getTaskResponse(task))
      return
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/generate/floor-plan') {
      const body = await readRequestBody(req)
      const result = await handleImageGeneration({ requestId, body, config })
      const cachedImage = cacheGeneratedImage({
        imageBase64: result.imageBase64,
        imageMimeType: result.imageMimeType,
      })
      sendJson(res, 200, {
        ok: true,
        ...result,
        imageId: cachedImage.id,
        imageUrl: `${buildPublicBaseUrl(req, config)}/api/generated-image/${cachedImage.id}`,
        imageMimeType: cachedImage.mimeType,
      })
      return
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/generate/render') {
      const body = await readRequestBody(req)
      const result = await handleRenderGeneration({ requestId, body, config })
      const cachedImage = cacheGeneratedImage({
        imageBase64: result.imageBase64,
        imageMimeType: result.imageMimeType,
      })
      sendJson(res, 200, {
        ok: true,
        ...result,
        imageId: cachedImage.id,
        imageUrl: `${buildPublicBaseUrl(req, config)}/api/generated-image/${cachedImage.id}`,
        imageMimeType: cachedImage.mimeType,
      })
      return
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/generate/controlled-edit') {
      const body = await readRequestBody(req)
      const result = await handleImageGeneration({ requestId, body, config })
      const cachedImage = cacheGeneratedImage({
        imageBase64: result.imageBase64,
        imageMimeType: result.imageMimeType,
      })
      sendJson(res, 200, {
        ok: true,
        ...result,
        imageId: cachedImage.id,
        imageUrl: `${buildPublicBaseUrl(req, config)}/api/generated-image/${cachedImage.id}`,
        imageMimeType: cachedImage.mimeType,
      })
      return
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/generate/design-summary') {
      const body = await readJsonBody(req)
      const result = await handleTextGeneration({ requestId, body, config })
      sendJson(res, 200, {
        ok: true,
        ...result,
      })
      return
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/generate/final-design-summary') {
      const body = await readJsonBody(req)
      const prompt = buildFinalDesignPrompt(body)
      const result = await handleTextGeneration({
        requestId,
        body: {
          prompt,
          model: body.model || config.textModel,
        },
        config,
      })

      sendJson(res, 200, {
        ok: true,
        text: result.text || '',
        prompt,
      })
      return
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/export/design-pdf') {
      const body = await readJsonBody(req)
      const designText = String(body.finalDesignText || body.designText || '').trim()
      const renderImageIds = Array.isArray(body.renderImageIds)
        ? body.renderImageIds.filter((item) => typeof item === 'string' && item.trim())
        : []

      if (
        !String(body.floorPlanImageId || '').trim() &&
        !String(body.renderImageId || '').trim() &&
        !renderImageIds.length
      ) {
        throw new Error('导出 PDF 失败：至少需要一张方案图。')
      }

      const fileName = buildPdfFileName(body.servicePeople, body.spaceType)
      const pdfBuffer = await generateDesignPdfBuffer({
        servicePeople: body.servicePeople,
        spaceType: body.spaceType,
        areaText: body.areaText,
        budgetRange: body.budgetRange,
        coreNeeds: body.coreNeeds,
        constraints: body.constraints,
        selectedFurnitureLabels: body.selectedFurnitureLabels,
        floorPlanImageId: body.floorPlanImageId,
        renderImageId: body.renderImageId,
        renderImageIds,
        designText,
        exportedAt: body.exportedAt,
      })
      const cachedFile = cacheGeneratedFile({
        buffer: pdfBuffer,
        mimeType: 'application/pdf',
        fileName,
      })

      sendJson(res, 200, {
        ok: true,
        fileId: cachedFile.id,
        fileName: cachedFile.fileName,
        mimeType: cachedFile.mimeType,
        fileUrl: `${buildPublicBaseUrl(req, config)}/api/generated-file/${cachedFile.id}`,
      })
      return
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/api/share/plan') {
      const body = await readJsonBody(req)
      const sharedPlan = cacheSharedPlan(body)

      sendJson(res, 200, {
        ok: true,
        shareId: sharedPlan.id,
        sharePath: `/pages/plan-detail/index?shareId=${encodeURIComponent(sharedPlan.id)}`,
      })
      return
    }

    sendJson(res, 404, {
      ok: false,
      error: `未找到接口：${req.method} ${parsedUrl.pathname}`,
    })
  } catch (error) {
    const message = error && error.message ? error.message : '未知错误'
    log('error', requestId, '请求处理失败', {
      method: req.method,
      path: parsedUrl.pathname,
      elapsedMs: Date.now() - startedAt,
      error: message,
    })
    sendJson(res, 500, {
      ok: false,
      error: message,
    })
  } finally {
    log('info', requestId, '请求处理结束', {
      method: req.method,
      path: parsedUrl.pathname,
      elapsedMs: Date.now() - startedAt,
    })
  }
}

const config = getConfig()
const server = http.createServer((req, res) => {
  handleRequest(req, res)
})

server.listen(config.port, config.host, () => {
  log('info', 'bootstrap', '服务启动成功', {
    host: config.host,
    port: config.port,
    timeoutMs: config.timeoutMs,
    hasVisionApiKey: Boolean(config.visionApiKey),
    hasTextApiKey: Boolean(config.textApiKey),
  })
})
