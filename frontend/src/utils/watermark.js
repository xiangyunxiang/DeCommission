/**
 * Apply a tiled diagonal watermark to an image File using Canvas API.
 * @param {File} file       — original image file
 * @param {string} [label]  — watermark text (default "PREVIEW ONLY")
 * @returns {Promise<Blob>} — watermarked image as JPEG blob
 */
export function applyWatermark(file, label = "PREVIEW ONLY") {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      const canvas = document.createElement("canvas")
      canvas.width  = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext("2d")

      // Draw original image
      ctx.drawImage(img, 0, 0)

      // Watermark text settings
      const fontSize = Math.max(Math.min(img.naturalWidth / 7, 110), 28)
      ctx.save()
      ctx.globalAlpha  = 0.38
      ctx.fillStyle    = "#ffffff"
      ctx.strokeStyle  = "#000000"
      ctx.lineWidth    = Math.max(fontSize / 22, 1)
      ctx.font         = `bold ${fontSize}px sans-serif`
      ctx.textAlign    = "center"
      ctx.textBaseline = "middle"

      // Tile diagonally across the entire canvas
      const step = fontSize * 5
      for (let x = -step; x < img.naturalWidth + step; x += step) {
        for (let y = -step; y < img.naturalHeight + step; y += step) {
          ctx.save()
          ctx.translate(x, y)
          ctx.rotate(-Math.PI / 6)
          ctx.strokeText(label, 0, 0)
          ctx.fillText(label, 0, 0)
          ctx.restore()
        }
      }
      ctx.restore()

      URL.revokeObjectURL(url)
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error("Canvas toBlob failed")),
        "image/jpeg",
        0.92,
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("Failed to load image for watermarking"))
    }

    img.src = url
  })
}
