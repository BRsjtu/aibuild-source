function getHeader(headers, key) {
  const target = String(key || '').toLowerCase()
  const source = headers || {}
  const names = Object.keys(source)

  for (let i = 0; i < names.length; i += 1) {
    if (String(names[i]).toLowerCase() === target) {
      return String(source[names[i]] || '')
    }
  }

  return ''
}

function inferImageExtension(imageUrl, contentType) {
  const mime = String(contentType || '').toLowerCase()
  const url = String(imageUrl || '').toLowerCase()

  if (mime.indexOf('png') >= 0 || url.indexOf('.png') >= 0) {
    return 'png'
  }

  if (mime.indexOf('webp') >= 0 || url.indexOf('.webp') >= 0) {
    return 'webp'
  }

  if (mime.indexOf('gif') >= 0 || url.indexOf('.gif') >= 0) {
    return 'gif'
  }

  return 'jpg'
}

function writeImageArrayBufferToLocalFile(imageUrl, arrayBuffer, contentType) {
  return new Promise((resolve, reject) => {
    const fileSystem = wx.getFileSystemManager && wx.getFileSystemManager()
    const userDataPath = wx.env && wx.env.USER_DATA_PATH

    if (!fileSystem || !userDataPath) {
      reject(new Error('当前环境不支持写入本地图片文件。'))
      return
    }

    const extension = inferImageExtension(imageUrl, contentType)
    const random = Math.random().toString(16).slice(2, 10)
    const filePath = `${userDataPath}/weiguang-image-${Date.now()}-${random}.${extension}`

    fileSystem.writeFile({
      filePath,
      data: arrayBuffer,
      success() {
        resolve(filePath)
      },
      fail(error) {
        reject(new Error(`写入本地图片失败。detail=${JSON.stringify(error)}`))
      },
    })
  })
}

function requestImageToLocalFile(imageUrl) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: imageUrl,
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: 60000,
      success(res) {
        if (
          res.statusCode >= 200 &&
          res.statusCode < 300 &&
          res.data &&
          res.data.byteLength > 0
        ) {
          writeImageArrayBufferToLocalFile(
            imageUrl,
            res.data,
            getHeader(res.header, 'content-type')
          )
            .then(resolve)
            .catch(reject)
          return
        }

        reject(new Error(`请求图片字节失败。status=${res.statusCode}`))
      },
      fail(error) {
        reject(new Error(`请求图片字节失败。detail=${JSON.stringify(error)}`))
      },
    })
  })
}

function saveTempImageForDisplay(tempFilePath) {
  const filePath = String(tempFilePath || '').trim()

  if (!filePath || !wx.saveFile) {
    return Promise.resolve(filePath)
  }

  return new Promise((resolve) => {
    wx.saveFile({
      tempFilePath: filePath,
      success(res) {
        resolve(res.savedFilePath || filePath)
      },
      fail() {
        resolve(filePath)
      },
    })
  })
}

function downloadImageForDisplay(imageUrl) {
  const url = String(imageUrl || '').trim()

  if (!url || !/^https?:\/\//i.test(url)) {
    return Promise.resolve(url)
  }

  return new Promise((resolve) => {
    wx.downloadFile({
      url,
      timeout: 60000,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.tempFilePath) {
          saveTempImageForDisplay(res.tempFilePath).then(resolve)
          return
        }

        requestImageToLocalFile(url)
          .then(resolve)
          .catch(() => resolve(url))
      },
      fail() {
        requestImageToLocalFile(url)
          .then(resolve)
          .catch(() => resolve(url))
      },
    })
  })
}

module.exports = {
  downloadImageForDisplay,
}
