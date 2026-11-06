const { requestBackendGet } = require('../../lib/weiguang-api')
const { downloadImageForDisplay } = require('../../lib/image-display')
const {
  getConfiguredBaseUrl,
  savePendingCasePreset,
  formatDisplayLabel,
} = require('../../lib/weiguang-data')

const CASE_PAGE_SIZE = 4

Page({
  data: {
    baseUrl: getConfiguredBaseUrl(),
    caseStudies: [],
    visibleCaseStudies: [],
    visibleCaseCount: CASE_PAGE_SIZE,
    hasMoreCases: false,
    loading: true,
    errorMessage: '',
  },

  onShow() {
    const baseUrl = getConfiguredBaseUrl()

    if (this.data.caseStudies.length && this.data.baseUrl === baseUrl && !this.data.errorMessage) {
      return
    }

    this.loadCases()
  },

  async loadCases() {
    this.setData({
      loading: true,
      errorMessage: '',
      baseUrl: getConfiguredBaseUrl(),
    })

    try {
      const response = await requestBackendGet({
        baseUrl: getConfiguredBaseUrl(),
        path: '/api/library/cases',
      })
      const caseStudies = Array.isArray(response.items) ? response.items : []
      const visibleCaseCount = Math.min(CASE_PAGE_SIZE, caseStudies.length)

      this.setData({
        loading: false,
        caseStudies,
        visibleCaseCount,
        visibleCaseStudies: caseStudies.slice(0, visibleCaseCount),
        hasMoreCases: visibleCaseCount < caseStudies.length,
      })
      this.hydrateVisibleCaseCovers(0, visibleCaseCount)
    } catch (error) {
      this.setData({
        loading: false,
        errorMessage: error && error.message ? error.message : '案例库加载失败，请稍后重试。',
      })
    }
  },

  loadMoreCases() {
    if (this.data.loading || !this.data.hasMoreCases) {
      return
    }

    const caseStudies = this.data.caseStudies || []
    const previousVisibleCaseCount = this.data.visibleCaseCount
    const visibleCaseCount = Math.min(
      this.data.visibleCaseCount + CASE_PAGE_SIZE,
      caseStudies.length
    )

    this.setData({
      visibleCaseCount,
      visibleCaseStudies: caseStudies.slice(0, visibleCaseCount),
      hasMoreCases: visibleCaseCount < caseStudies.length,
    })
    this.hydrateVisibleCaseCovers(previousVisibleCaseCount, visibleCaseCount)
  },

  async hydrateVisibleCaseCovers(startIndex, endIndex) {
    const caseStudies = [].concat(this.data.caseStudies || [])
    const tasks = []

    for (let index = startIndex; index < endIndex; index += 1) {
      const item = caseStudies[index]
      const sourceUrl = item && (item.coverPreviewImageUrl || item.coverImageUrl)

      if (!item || item.coverDisplayImagePath || !sourceUrl) {
        continue
      }

      tasks.push(
        downloadImageForDisplay(sourceUrl)
          .then((coverDisplayImagePath) => ({
            index,
            coverDisplayImagePath,
          }))
          .catch(() => null)
      )
    }

    const results = (await Promise.all(tasks)).filter(Boolean)

    if (!results.length) {
      return
    }

    results.forEach((result) => {
      caseStudies[result.index] = {
        ...caseStudies[result.index],
        coverDisplayImagePath: result.coverDisplayImagePath,
      }
    })

    this.setData({
      caseStudies,
      visibleCaseStudies: caseStudies.slice(0, this.data.visibleCaseCount),
    })
  },

  goToNewPlan() {
    wx.redirectTo({
      url: '/pages/index/index',
    })
  },

  goToHistory() {
    wx.redirectTo({
      url: '/pages/history/index',
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

  applyCasePreset(event) {
    const id = String(event.currentTarget.dataset.id || '').trim()
    const caseItem = (this.data.caseStudies || []).find((item) => item.id === id)

    if (!caseItem) {
      return
    }

    savePendingCasePreset(caseItem)
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

  formatCaseMeta(event) {
    const item = event.currentTarget.dataset.item || {}
    return formatDisplayLabel(item.spaceType, '')
  },
})
