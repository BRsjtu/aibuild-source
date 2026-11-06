/**
 * Gemini 3.1 Flash Image 原生接口封装。
 *
 * 作用：
 * - 封装 `gemini-3.1-flash-image-preview` 的文生图请求。
 * - 封装 `gemini-3.1-flash-image-preview` 的图生图请求。
 * - 提供从响应中提取首张图片和文本的方法。
 *
 * 使用示例：
 * ```javascript
 * const gemini = require('../../utils/gemini-native')
 *
 * const result = await gemini.generateImageFromText({
 *   baseUrl: 'https://yunwu.ai/v1',
 *   apiKey: 'your-api-key',
 *   prompt: 'A red apple on a wooden table.',
 * })
 * ```
 */

const DEFAULT_MODEL = 'gemini-3.1-flash-image-preview'
const DEFAULT_PATH = '/v1beta/models/'
const DEFAULT_ACTION = ':generateContent'
const DEFAULT_TIMEOUT_MS = 120000

/**
 * 规范化 baseUrl，避免出现重复斜杠。
 *
 * @param {string} baseUrl 接口基础地址，例如 `https://yunwu.ai/v1`
 * @returns {string} 去掉结尾斜杠后的地址
 */
function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '')
}

/**
 * 构造 Gemini 原生接口 URL。
 *
 * 说明：
 * - 当前渠道实测可用形式为：
 *   `https://yunwu.ai/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=...`
 * - 即使外部提供的 baseUrl 为 `/v1`，这里仍然按实测结果固定改为 `/v1beta` 路径。
 *
 * @param {Object} params 参数对象
 * @param {string} params.baseUrl 渠道基础地址
 * @param {string} params.apiKey 渠道 API Key
 * @param {string} [params.model] 模型名称
 * @returns {string} 最终请求 URL
 */
function buildNativeUrl({ baseUrl, apiKey, model = DEFAULT_MODEL }) {
  const root = normalizeBaseUrl(baseUrl).replace(/\/v1(?:beta)?$/i, '')
  const encodedKey = encodeURIComponent(apiKey)
  return `${root}${DEFAULT_PATH}${model}${DEFAULT_ACTION}?key=${encodedKey}`
}

/**
 * 构造文生图请求体。
 *
 * @param {Object} params 参数对象
 * @param {string} params.prompt 图片提示词
 * @param {string} [params.aspectRatio='1:1'] 宽高比，例如 `1:1`、`16:9`
 * @param {string} [params.imageSize='1K'] 图片尺寸，例如 `1K`、`2K`
 * @param {boolean} [params.includeText=true] 是否同时返回文本
 * @returns {Object} Gemini 原生请求体
 */
function buildTextToImageBody({
  prompt,
  aspectRatio = '1:1',
  imageSize = '1K',
  includeText = true,
}) {
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
      responseModalities: includeText ? ['TEXT', 'IMAGE'] : ['IMAGE'],
      imageConfig: {
        aspectRatio,
        imageSize,
      },
    },
  }
}

/**
 * 构造图生图请求体。
 *
 * @param {Object} params 参数对象
 * @param {string} params.prompt 图片编辑提示词
 * @param {string} params.imageBase64 输入图片的 base64 内容，不带 data URL 前缀
 * @param {string} [params.mimeType='image/jpeg'] 输入图片 MIME 类型
 * @param {string} [params.aspectRatio='1:1'] 输出图片宽高比
 * @param {string} [params.imageSize='1K'] 输出图片尺寸
 * @param {boolean} [params.includeText=true] 是否同时返回文本
 * @returns {Object} Gemini 原生请求体
 */
function buildImageEditBody({
  prompt,
  imageBase64,
  mimeType = 'image/jpeg',
  aspectRatio = '1:1',
  imageSize = '1K',
  includeText = true,
}) {
  return {
    contents: [
      {
        parts: [
          {
            text: prompt,
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: includeText ? ['TEXT', 'IMAGE'] : ['IMAGE'],
      imageConfig: {
        aspectRatio,
        imageSize,
      },
    },
  }
}

/**
 * 使用小程序文件系统读取本地图片并转为 base64。
 *
 * @param {string} filePath 本地临时文件或本地路径
 * @returns {Promise<string>} 图片 base64 内容
 */
function isHttpTempPath(filePath) {
  return /^http:\/\/tmp\//i.test(String(filePath || ''))
}

function readFileAsBase64Once(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success(res) {
        resolve(res.data)
      },
      fail(err) {
        reject(
          new Error(
            `读取图片失败，请检查路径是否可访问。filePath=${filePath} detail=${JSON.stringify(err)}`
          )
        )
      },
    })
  })
}

function getImageInfoPath(filePath) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: filePath,
      success(res) {
        resolve(res.path || filePath)
      },
      fail(err) {
        reject(
          new Error(
            `getImageInfo 失败。filePath=${filePath} detail=${JSON.stringify(err)}`
          )
        )
      },
    })
  })
}

function compressImagePath(filePath) {
  return new Promise((resolve, reject) => {
    wx.compressImage({
      src: filePath,
      quality: 100,
      success(res) {
        resolve(res.tempFilePath || filePath)
      },
      fail(err) {
        reject(
          new Error(
            `compressImage 失败。filePath=${filePath} detail=${JSON.stringify(err)}`
          )
        )
      },
    })
  })
}

async function readImageAsBase64(filePath) {
  const normalizedPath = String(filePath || '')
  const errorList = []

  try {
    return await readFileAsBase64Once(normalizedPath)
  } catch (error) {
    errorList.push(`direct=${error.message}`)
  }

  const candidatePaths = []

  if (isHttpTempPath(normalizedPath)) {
    try {
      const imageInfoPath = await getImageInfoPath(normalizedPath)

      if (imageInfoPath && imageInfoPath !== normalizedPath) {
        candidatePaths.push(imageInfoPath)
      }
    } catch (error) {
      errorList.push(error.message)
    }

    try {
      const compressedPath = await compressImagePath(normalizedPath)

      if (compressedPath && compressedPath !== normalizedPath) {
        candidatePaths.push(compressedPath)
      }
    } catch (error) {
      errorList.push(error.message)
    }
  }

  const uniqueCandidatePaths = Array.from(new Set(candidatePaths))

  for (const candidatePath of uniqueCandidatePaths) {
    try {
      return await readFileAsBase64Once(candidatePath)
    } catch (error) {
      errorList.push(
        `fallbackRead=${candidatePath} detail=${error.message}`
      )
    }
  }

  throw new Error(
    `读取图片失败，请检查路径是否可访问。filePath=${normalizedPath} detail=${errorList.join(' | ')}`
  )
}

/**
 * 发送 Gemini 原生请求。
 *
 * @param {Object} params 参数对象
 * @param {string} params.baseUrl 渠道基础地址
 * @param {string} params.apiKey 渠道 API Key
 * @param {Object} params.body 请求体
 * @param {string} [params.model] 模型名称
 * @param {number} [params.timeoutMs=120000] 超时时间
 * @returns {Promise<Object>} 原始响应对象
 */
function requestGeminiNative({
  baseUrl,
  apiKey,
  body,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const url = buildNativeUrl({
    baseUrl,
    apiKey,
    model,
  })

  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: 'POST',
      timeout: timeoutMs,
      header: {
        'Content-Type': 'application/json',
      },
      data: body,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
          return
        }

        reject(
          new Error(
            `Gemini 请求失败。status=${res.statusCode} detail=${JSON.stringify(res.data)}`
          )
        )
      },
      fail(err) {
        reject(
          new Error(
            `Gemini 网络请求失败。url=${url} detail=${JSON.stringify(err)}`
          )
        )
      },
    })
  })
}

/**
 * 从 Gemini 原生响应中提取首张图片和拼接文本。
 *
 * @param {Object} response Gemini 原生响应
 * @returns {{imageBase64: string, text: string, parts: Array}} 提取结果
 */
function parseGeminiResponse(response) {
  const candidates = response && response.candidates ? response.candidates : []
  const first = candidates[0] || {}
  const content = first.content || {}
  const parts = Array.isArray(content.parts) ? content.parts : []

  let imageBase64 = ''
  const textList = []

  parts.forEach((part) => {
    if (part.text) {
      textList.push(part.text)
    }

    if (!imageBase64 && part.inline_data && part.inline_data.data) {
      imageBase64 = part.inline_data.data
    }

    if (!imageBase64 && part.inlineData && part.inlineData.data) {
      imageBase64 = part.inlineData.data
    }
  })

  return {
    imageBase64,
    text: textList.join('\n').trim(),
    parts,
  }
}

/**
 * 文生图封装。
 *
 * @param {Object} params 参数对象
 * @param {string} params.baseUrl 渠道基础地址
 * @param {string} params.apiKey 渠道 API Key
 * @param {string} params.prompt 图片提示词
 * @param {string} [params.model] 模型名称
 * @param {string} [params.aspectRatio='1:1'] 宽高比
 * @param {string} [params.imageSize='1K'] 图片尺寸
 * @param {boolean} [params.includeText=true] 是否返回文本
 * @returns {Promise<{response: Object, imageBase64: string, text: string, parts: Array}>}
 */
async function generateImageFromText({
  baseUrl,
  apiKey,
  prompt,
  model = DEFAULT_MODEL,
  aspectRatio = '1:1',
  imageSize = '1K',
  includeText = true,
}) {
  const body = buildTextToImageBody({
    prompt,
    aspectRatio,
    imageSize,
    includeText,
  })

  const response = await requestGeminiNative({
    baseUrl,
    apiKey,
    body,
    model,
  })

  return {
    response,
    ...parseGeminiResponse(response),
  }
}

/**
 * 图生图封装。
 *
 * @param {Object} params 参数对象
 * @param {string} params.baseUrl 渠道基础地址
 * @param {string} params.apiKey 渠道 API Key
 * @param {string} params.prompt 图片编辑提示词
 * @param {string} params.imageBase64 输入图片 base64
 * @param {string} [params.model] 模型名称
 * @param {string} [params.mimeType='image/jpeg'] 输入图片 MIME 类型
 * @param {string} [params.aspectRatio='1:1'] 输出宽高比
 * @param {string} [params.imageSize='1K'] 输出尺寸
 * @param {boolean} [params.includeText=true] 是否返回文本
 * @returns {Promise<{response: Object, imageBase64: string, text: string, parts: Array}>}
 */
async function editImageWithPrompt({
  baseUrl,
  apiKey,
  prompt,
  imageBase64,
  model = DEFAULT_MODEL,
  mimeType = 'image/jpeg',
  aspectRatio = '1:1',
  imageSize = '1K',
  includeText = true,
}) {
  const body = buildImageEditBody({
    prompt,
    imageBase64,
    mimeType,
    aspectRatio,
    imageSize,
    includeText,
  })

  const response = await requestGeminiNative({
    baseUrl,
    apiKey,
    body,
    model,
  })

  return {
    response,
    ...parseGeminiResponse(response),
  }
}

module.exports = {
  DEFAULT_MODEL,
  buildNativeUrl,
  buildTextToImageBody,
  buildImageEditBody,
  readImageAsBase64,
  requestGeminiNative,
  parseGeminiResponse,
  generateImageFromText,
  editImageWithPrompt,
}
