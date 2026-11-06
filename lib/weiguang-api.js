const { DEFAULT_BASE_URL, getConfiguredBaseUrl } = require('./weiguang-data')

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || getConfiguredBaseUrl() || DEFAULT_BASE_URL).trim()
  return value.replace(/\/+$/, '')
}

function requestBackendJson({ baseUrl, path, data, timeout = 180000, method = 'POST' }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${normalizeBaseUrl(baseUrl)}${path}`,
      method,
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
        reject(new Error(`后端网络请求失败。path=${path} detail=${JSON.stringify(err)}`))
      },
    })
  })
}

function requestBackendGet({ baseUrl, path, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${normalizeBaseUrl(baseUrl)}${path}`,
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
        reject(new Error(`后端查询失败。path=${path} detail=${JSON.stringify(err)}`))
      },
    })
  })
}

module.exports = {
  normalizeBaseUrl,
  requestBackendJson,
  requestBackendGet,
}
