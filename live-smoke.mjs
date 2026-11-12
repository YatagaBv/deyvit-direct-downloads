// End-to-end check against the public Render service. It reads each download
// without retaining the media on disk, so it verifies the real response bytes.
const base = process.env.DL_BASE_URL || 'https://deyvit-direct-downloads.onrender.com'
const origin = 'https://deyvit-blog.surge.sh'
const samples = [
  ['YouTube', 'https://www.youtube.com/watch?v=ViFHruS6oO8', 'p360'],
  ['TikTok', 'https://www.tiktok.com/@fundacionmaya.bo/video/7494380164235693317', 'video'],
  ['Instagram', 'https://www.instagram.com/reels/Dewd-4qNQ0T/', 'video'],
  ['Pinterest', 'https://es.pinterest.com/pin/1068971661536460645/', 'video'],
]

const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(30000) }).then(r => r.json())
console.log('health', health)
let failed = 0
for (const [platform, url, format] of samples) {
  const started = Date.now()
  try {
    const response = await fetch(`${base}/api/dl/prepare`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format }),
      signal: AbortSignal.timeout(100000),
    })
    const data = await response.json()
    if (!response.ok || !data.token) throw new Error(`prepare ${response.status}: ${data.error || 'sin token'}`)
    const file = await fetch(`${base}/api/dl/file/${data.token}`, { signal: AbortSignal.timeout(100000) })
    if (!file.ok || !file.body) throw new Error(`file ${file.status}`)
    let bytes = 0
    for await (const chunk of file.body) bytes += chunk.length
    if (bytes !== data.size || bytes < 1024) throw new Error(`tamaño incorrecto: ${bytes} / ${data.size}`)
    console.log(`${platform}: OK ${bytes} bytes, ${data.filename}, ${((Date.now() - started) / 1000).toFixed(1)} s`)
  } catch (error) {
    failed++
    console.log(`${platform}: ERROR ${String(error)}, ${((Date.now() - started) / 1000).toFixed(1)} s`)
  }
}
if (failed) process.exitCode = 1
