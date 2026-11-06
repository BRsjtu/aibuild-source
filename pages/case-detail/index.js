const { requestBackendGet } = require('../../lib/weiguang-api')
const { downloadImageForDisplay } = require('../../lib/image-display')
const { getConfiguredBaseUrl, savePendingCasePreset } = require('../../lib/weiguang-data')

async function buildCaseDisplayImages(caseItem) {
  const item = caseItem || {}
  const [
    beforeDisplayImagePath,
    floorPlanDisplayImagePath,
    renderDisplayImagePath,
  ] = await Promise.all([
    item.beforeImageUrl ? downloadImageForDisplay(item.beforeImageUrl) : '',
    item.floorPlanImageUrl ? downloadImageForDisplay(item.floorPlanImageUrl) : '',
    item.renderImageUrl || item.coverImageUrl
      ? downloadImageForDisplay(item.renderImageUrl || item.coverImageUrl)
      : '',
  ])

  return {
    ...item,
    beforeDisplayImagePath,
    floorPlanDisplayImagePath,
    renderDisplayImagePath,
  }
}

Page({
  data: {
    baseUrl: getConfiguredBaseUrl(),
    caseId: '',
    caseItem: null,
    loading: true,
    errorMessage: '',
  },

  onLoad(query) {
    this.setData({
      caseId: String((query && query.id) || '').trim(),
    })
  },

  onShow() {
    this.loadCaseDetail()
  },

  async loadCaseDetail() {
    const caseId = this.data.caseId

    if (!caseId) {
      this.setData({
        loading: false,
        errorMessage: '缺少案例 ID。',
      })
      return
    }

    this.setData({
      loading: true,
      errorMessage: '',
      baseUrl: getConfiguredBaseUrl(),
    })

    try {
      const response = await requestBackendGet({
        baseUrl: getConfiguredBaseUrl(),
        path: `/api/library/cases/${encodeURIComponent(caseId)}`,
      })
      const caseItem = response && response.item ? response.item : null

      if (!caseItem) {
        throw new Error('未找到该案例。')
      }

      this.setData({
        loading: false,
        caseItem: await buildCaseDisplayImages(caseItem),
      })
    } catch (error) {
      this.setData({
        loading: false,
        errorMessage: error && error.message ? error.message : '案例加载失败，请稍后重试。',
      })
    }
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

  applyCasePreset() {
    if (!this.data.caseItem) {
      return
    }

    savePendingCasePreset(this.data.caseItem)
    wx.showToast({
      title: '已带回首页套用',
      icon: 'success',
    })
    setTimeout(() => {
      wx.redirectTo({
        url: '/pages/index/index',
      })
    }, 300)
  },

  goBackToCases() {
    wx.navigateBack({
      fail: () => {
        wx.redirectTo({
          url: '/pages/cases/index',
        })
      },
    })
  },
})
