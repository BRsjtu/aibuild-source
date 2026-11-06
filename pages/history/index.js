const { loadHistoryRecords } = require('../../lib/weiguang-data')
const { downloadImageForDisplay } = require('../../lib/image-display')

function formatDateTime(value) {
  if (!value) {
    return ''
  }

  const date = new Date(Number(value))

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return date.toLocaleString('zh-CN', { hour12: false })
}

Page({
  data: {
    historyRecords: [],
  },

  onShow() {
    this.refreshHistory()
  },

  async refreshHistory() {
    const records = await Promise.all(loadHistoryRecords().map(async (item) => ({
      ...item,
      updatedAtText: formatDateTime(item.updatedAt),
      renderViewCount: Array.isArray(item.renderViews) ? item.renderViews.length : item.renderImageUrl ? 1 : 0,
      coverDisplayImagePath: item.coverImageUrl
        ? await downloadImageForDisplay(item.coverImageUrl)
        : '',
      statusText: item.finalDesignText
        ? '已完成'
        : item.renderImageUrl
          ? '待补充最终说明'
          : '仅生成基础结果',
    })))

    this.setData({
      historyRecords: records,
    })
  },

  goToNewPlan() {
    wx.redirectTo({
      url: '/pages/index/index',
    })
  },

  goToCases() {
    wx.redirectTo({
      url: '/pages/cases/index',
    })
  },

  openPlanDetail(event) {
    const id = String(event.currentTarget.dataset.id || '').trim()

    if (!id) {
      return
    }

    wx.navigateTo({
      url: `/pages/plan-detail/index?id=${encodeURIComponent(id)}`,
    })
  },
})
