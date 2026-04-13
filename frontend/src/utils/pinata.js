import { applyWatermark } from "./watermark.js"

const PINATA_JWT   = import.meta.env.VITE_PINATA_JWT
const IPFS_GATEWAY = import.meta.env.VITE_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs/"

/**
 * Upload a File object to Pinata and return the IPFS CID.
 * @param {File} file
 * @returns {Promise<string>} CID (e.g. "QmXyz...")
 */
export async function uploadFileToPinata(file) {
  const form = new FormData()
  form.append("file", file)

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PINATA_JWT}`,
    },
    body: form,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Pinata upload failed (${res.status}): ${text}`)
  }

  const data = await res.json()
  return data.IpfsHash
}

/**
 * Upload a plain-object as a JSON file to Pinata and return the IPFS CID.
 * @param {object} obj
 * @param {string} [filename]
 * @returns {Promise<string>} CID
 */
export async function uploadJsonToPinata(obj, filename = "data.json") {
  const blob = new Blob([JSON.stringify(obj)], { type: "application/json" })
  const file = new File([blob], filename)
  return uploadFileToPinata(file)
}

/**
 * Build a gateway URL from a CID.
 * @param {string} cid
 * @returns {string}
 */
export const ipfsGatewayUrl = (cid) => `${IPFS_GATEWAY}${cid}`

/**
 * Upload a delivery file as TWO versions (watermarked + original) and store
 * a metadata JSON pointing to both.  The returned CID (stored on-chain) is
 * the metadata JSON — not the image itself.
 *
 * Metadata JSON shape: { watermarkedCid: string, originalCid: string }
 *
 * @param {File} file — original delivery image
 * @returns {Promise<string>} metadata CID to store on-chain
 */
export async function uploadDelivery(file) {
  // 1. Produce watermarked blob via Canvas
  const watermarkedBlob = await applyWatermark(file)
  const watermarkedFile = new File([watermarkedBlob], `wm_${file.name}`, { type: "image/jpeg" })

  // 2. Upload original + watermarked in parallel
  const [originalCid, watermarkedCid] = await Promise.all([
    uploadFileToPinata(file),
    uploadFileToPinata(watermarkedFile),
  ])

  // 3. Upload metadata JSON; its CID goes on-chain
  const metaCid = await uploadJsonToPinata(
    { watermarkedCid, originalCid },
    `delivery-meta-${Date.now()}.json`,
  )
  return metaCid
}

