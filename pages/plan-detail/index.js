const { requestBackendJson, requestBackendGet } = require('../../lib/weiguang-api')
const {
  FORM_STORAGE_KEY,
  buildPlanRecord,
  getPlanRecordById,
  loadCurrentPlanRecord,
  buildPdfPayloadFromPlanRecord,
} = require('../../lib/weiguang-data')
const { downloadImageForDisplay } = require('../../lib/image-display')

function renderInlineMarkdown(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
        html: renderInlineMarkdown(orderedMatch[1]),
      })
      return
    }

    closeList()
    blocks.push({
      type: 'paragraph',
      html: renderInlineMarkdown(line),
    })
  })

  closeList()
  return blocks
}

function loadCachedFormPhotoPaths() {
  try {
    const form = wx.getStorageSync(FORM_STORAGE_KEY)
    return Array.isArray(form && form.photoPaths)
      ? form.photoPaths.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  } catch (error) {
    return []
  }
}

function attachFallbackOriginalPhotos(record) {
  if (!record || (Array.isArray(record.photoPaths) && record.photoPaths.length)) {
    return record
  }

  const currentRecord = loadCurrentPlanRecord()

  if (!currentRecord || !record.id || currentRecord.id !== record.id) {
    return record
  }

  const photoPaths = loadCachedFormPhotoPaths()

  if (!photoPaths.length) {
    return record
  }

  return buildPlanRecord({
    ...record,
    photoPaths,
  })
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function canAccessLocalFile(filePath) {
  const path = String(filePath || '').trim()
  const fileSystem = wx.getFileSystemManager && wx.getFileSystemManager()

  if (!path || isHttpUrl(path) || !fileSystem) {
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    fileSystem.access({
      path,
      success() {
        resolve(true)
      },
      fail() {
        resolve(false)
      },
    })
  })
}

async function resolveOriginalPhotoDisplayPath(imagePath) {
  const path = String(imagePath || '').trim()

  if (!path) {
    return ''
  }

  const displayPath = await downloadImageForDisplay(path).catch(() => '')

  if (!displayPath || isHttpUrl(displayPath)) {
    return ''
  }

  return (await canAccessLocalFile(displayPath)) ? displayPath : ''
}

async function buildRecordDisplayImages(record) {
  if (!record) {
    return null
  }

  const photoPaths = Array.isArray(record.photoPaths) ? record.photoPaths : []
  const renderViews = Array.isArray(record.renderViews) ? record.renderViews : []
  const [
    originalPhotos,
    floorPlanDisplayImagePath,
    renderDisplayImagePath,
    displayRenderViews,
  ] = await Promise.all([
    Promise.all(
      photoPaths.map(async (imagePath, index) => {
        const displayImagePath = await resolveOriginalPhotoDisplayPath(imagePath)

        return {
          sourceIndex: index,
          title: photoPaths.length > 1 ? `原图 ${index + 1}` : '原图',
          imagePath,
          displayImagePath,
          previewImagePath: displayImagePath || imagePath,
          unavailable: Boolean(imagePath && !displayImagePath),
        }
      })
    ),
    record.floorPlanImagePath ||
      (record.floorPlanImageUrl ? downloadImageForDisplay(record.floorPlanImageUrl).catch(() => '') : ''),
    record.renderImagePath ||
      (record.renderImageUrl ? downloadImageForDisplay(record.renderImageUrl).catch(() => '') : ''),
    Promise.all(
      renderViews.map(async (item) => ({
        ...item,
        displayImagePath: item.imagePath || (item.imageUrl
          ? await downloadImageForDisplay(item.imageUrl).catch(() => '')
          : ''),
      }))
    ),
  ])

  return {
    ...record,
    originalPhotos,
    floorPlanDisplayImagePath,
    renderDisplayImagePath,
    renderViews: displayRenderViews,
  }
}

Page({
  data: {
    recordId: '',
    shareId: '',
    record: null,
    primaryOriginalPhoto: null,
    secondaryOriginalPhotos: [],
    originalPhotos: [],
    renderViews: [],
    designBlocks: [],
    loadingRecord: true,
    exportLoading: false,
    sharePreparing: false,
    errorMessage: '',
  },

  onLoad(query) {
    this.setData({
      recordId: String((query && query.id) || '').trim(),
      shareId: String((query && query.shareId) || '').trim(),
    })
  },

  async onShow() {
    await this.loadRecord()
    this.prepareSharePath()
  },

  onShareAppMessage() {
    const record = this.data.record || loadCurrentPlanRecord()
    const sharePath = this.data.shareId
      ? `/pages/plan-detail/index?shareId=${encodeURIComponent(this.data.shareId)}`
      : '/pages/index/index'

    return {
      title: (record && record.title) || '微光空间改造方案',
      path: sharePath,
      imageUrl: (record && record.coverImageUrl) || '',
    }
  },

  async loadRecord() {
    this.setData({
      loadingRecord: true,
      errorMessage: '',
    })

    let record = getPlanRecordById(this.data.recordId)

    if (!record && this.data.shareId) {
      try {
        const response = await requestBackendGet({
          baseUrl: loadCurrentPlanRecord()?.baseUrl || 'http://127.0.0.1:3010/weiguang',
          path: `/api/shared-plan/${encodeURIComponent(this.data.shareId)}`,
        })
        record = buildPlanRecord(response.plan || null)
      } catch (error) {
        this.setData({
          errorMessage: error && error.message ? error.message : '分享方案加载失败。',
          loadingRecord: false,
        })
      }
    }

    const baseRecord = attachFallbackOriginalPhotos(record)

    if (!baseRecord) {
      this.setData({
        record: null,
        primaryOriginalPhoto: null,
        secondaryOriginalPhotos: [],
        originalPhotos: [],
        renderViews: [],
        designBlocks: [],
        loadingRecord: false,
      })
      return
    }

    const baseOriginalPhotos = (Array.isArray(baseRecord.photoPaths) ? baseRecord.photoPaths : []).map(
      (imagePath, index) => ({
        sourceIndex: index,
        title: baseRecord.photoPaths.length > 1 ? `原图 ${index + 1}` : '原图',
        imagePath,
        displayImagePath: '',
        previewImagePath: imagePath,
        unavailable: false,
      })
    )

    this.setData({
      record: {
        ...baseRecord,
        floorPlanDisplayImagePath: baseRecord.floorPlanImagePath || '',
        renderDisplayImagePath: baseRecord.renderImagePath || '',
      },
      primaryOriginalPhoto: baseOriginalPhotos[0] || null,
      secondaryOriginalPhotos: baseOriginalPhotos.slice(1),
      originalPhotos: baseOriginalPhotos,
      renderViews: (baseRecord && baseRecord.renderViews) || [],
      designBlocks: markdownToBlocks(
        (baseRecord && (baseRecord.finalDesignText || baseRecord.designText)) || ''
      ),
      loadingRecord: false,
    })

    const displayRecord = await buildRecordDisplayImages(baseRecord)

    if (!displayRecord || displayRecord.id !== baseRecord.id) {
      return
    }

    this.setData({
      record: displayRecord,
      primaryOriginalPhoto:
        displayRecord.originalPhotos && displayRecord.originalPhotos[0]
          ? displayRecord.originalPhotos[0]
          : null,
      secondaryOriginalPhotos: displayRecord.originalPhotos ? displayRecord.originalPhotos.slice(1) : [],
      originalPhotos: displayRecord.originalPhotos || [],
      renderViews: displayRecord.renderViews || [],
    })
  },

  async prepareSharePath() {
    const record = this.data.record

    if (!record || this.data.shareId) {
      return
    }

    this.setData({
      sharePreparing: true,
    })

    try {
      const response = await requestBackendJson({
        baseUrl: record.baseUrl,
        path: '/api/share/plan',
        data: record,
        timeout: 60000,
      })

      if (response.shareId) {
        this.setData({
          shareId: response.shareId,
          sharePreparing: false,
        })
        return
      }
    } catch (error) {
      // 分享快照失败时回退到首页分享，不阻断页面使用
    }

    this.setData({
      sharePreparing: false,
    })
  },

  previewImage(event) {
    const url = String(event.currentTarget.dataset.url || '').trim()

    if (!url) {
      return
    }

    wx.previewImage({
      current: url,
      urls: [url],
    })
  },

  goHome() {
    wx.redirectTo({
      url: '/pages/index/index',
    })
  },

  async exportPdf() {
    const record = this.data.record

    if (!record) {
      return
    }

    this.setData({
      exportLoading: true,
      errorMessage: '',
    })

    try {
      const payload = buildPdfPayloadFromPlanRecord(record)

      if (!payload) {
        throw new Error('缺少可导出的方案数据。')
      }

      const response = await requestBackendJson({
        baseUrl: record.baseUrl,
        path: '/api/export/design-pdf',
        data: payload,
        timeout: 240000,
      })

      const downloadUrl = `${String(record.baseUrl || '').replace(/\/+$/, '')}/api/generated-file/${response.fileId}`

      const downloadResult = await new Promise((resolve, reject) => {
        wx.downloadFile({
          url: downloadUrl,
          timeout: 240000,
          success: resolve,
          fail: reject,
        })
      })

      if (
        downloadResult.statusCode < 200 ||
        downloadResult.statusCode >= 300 ||
        !downloadResult.tempFilePath
      ) {
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
        exportLoading: false,
      })
      wx.showToast({
        title: 'PDF 已打开',
        icon: 'success',
      })
    } catch (error) {
      this.setData({
        exportLoading: false,
        errorMessage: error && error.message ? error.message : '导出 PDF 失败，请稍后重试。',
      })
    }
  },
})
