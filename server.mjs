import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const binary = process.env.YT_DLP_PATH || path.join(root, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
const ffmpeg = process.env.FFMPEG_PATH || path.join(root, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const port = Number(process.env.PORT || 8080)
const allowedOrigins = new Set([
  'https://deyvit-blog.surge.sh',
  'https://yatagabv.blogspot.com',
  'http://127.0.0.1:4175',
  'http://localhost:4175',
])
const formats = {
  best: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
  fhd: ['-f', 'bv*[height<=1080]+ba/b[height<=1080]', '--merge-output-format', 'mp4'],
  hd: ['-f', 'bv*[height<=720]+ba/b[height<=720]', '--merge-output-format', 'mp4'],
  sd: ['-f', 'b[height<=480]/bv*[height<=480]+ba', '--merge-output-format', 'mp4'],
  p360: ['-f', 'bv*[height<=360]+ba/b[height<=360]', '--merge-output-format', 'mp4'],
  p240: ['-f', 'bv*[height<=240]+ba/b[height<=240]', '--merge-output-format', 'mp4'],
  p144: ['-f', 'bv*[height<=144]+ba/b[height<=144]', '--merge-output-format', 'mp4'],
  video: ['-f', 'b/bv*+ba', '--merge-output-format', 'mp4'],
  audio: ['-f', 'ba/bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  'audio-best': ['-f', 'ba/bestaudio'],
  m4a: ['-f', 'ba/bestaudio', '-x', '--audio-format', 'm4a'],
  jpg: ['--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg'],
  image: [],
  photos: [],
}
const jobs = new Map()
const prepared = new Map()
const failures = new Map()
const preparing = new Set()
let active = 0
const waiting = []

function reserveSlot() {
  if (active < 2) { active++; return Promise.resolve() }
  if (waiting.length >= 8) return Promise.reject(new Error('El descargador está ocupado. Vuelve a intentarlo en un momento.'))
  return new Promise((resolve, reject) => {
    const entry = { resolve, timer: undefined }
    entry.timer = setTimeout(() => {
      const index = waiting.indexOf(entry)
      if (index !== -1) waiting.splice(index, 1)
      reject(new Error('La espera fue demasiado larga. Vuelve a intentarlo.'))
    }, 20000)
    waiting.push(entry)
  })
}

function releaseSlot() {
  active--
  const next = waiting.shift()
  if (next) {
    clearTimeout(next.timer)
    active++
    next.resolve()
  }
}

export function sourcePlatform(raw) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || raw.length > 1200) return null
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if ((host === 'tiktok.com' || host === 'www.tiktok.com' || host === 'm.tiktok.com') && /^\/@[^/]+\/(video|photo)\/\d+/.test(url.pathname)) return 'tiktok'
    if ((host === 'instagram.com' || host === 'www.instagram.com') && /^\/(reel|reels|p)\/[\w-]+/.test(url.pathname)) return 'instagram'
    if ((host === 'pinterest.com' || host.endsWith('.pinterest.com')) && /^\/pin\/(?:[\w-]+--)?\d+\/?$/.test(url.pathname)) return 'pinterest'
  } catch { /* enlace inválido */ }
  return null
}

function cors(res, origin) {
  if (!allowedOrigins.has(origin)) return false
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')
  return true
}

function json(res, status, value) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function removeTemp(dir) {
  const target = path.resolve(dir)
  if (path.dirname(target) === path.resolve(tmpdir()) && path.basename(target).startsWith('deyvit-dl-')) rmSync(target, { recursive: true, force: true })
}

function expire(id) {
  const job = jobs.get(id)
  if (!job) return
  if (job.readers) { job.timer = setTimeout(() => expire(id), 30000); return }
  jobs.delete(id)
  if (prepared.get(job.key) === id) prepared.delete(job.key)
  clearTimeout(job.timer)
  removeTemp(job.dir)
}

function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  if (/sign in to confirm|not a bot|login required|sign in/i.test(text)) return 'YouTube exige verificación o inicio de sesión desde este servidor; no puedo descargar este enlace aquí.'
  if (/403|challenge|blocked|Unexpected response/i.test(text)) return 'La plataforma bloqueó temporalmente la descarga de este video.'
  if (/private/i.test(text)) return 'Este video es privado o requiere permiso de acceso.'
  if (/timed out|timeout|tardó/i.test(text)) return 'La plataforma tardó demasiado en responder.'
  if (/Requested format is not available/i.test(text)) return 'Ese formato no está disponible para este video. Prueba otro formato.'
  return text.replace(/^ERROR:\s*/i, '').slice(0, 220)
}

function runDownload(url, format, dir, youtubeClients = '', isYoutube = false) {
  return new Promise((resolve, reject) => {
    const args = [
      '--ignore-config', '--no-playlist', '--no-warnings', '--js-runtimes', 'node', '--socket-timeout', '6',
      '--retries', '0', '--fragment-retries', '1', '--extractor-retries', '0',
      '--concurrent-fragments', '4', '--ffmpeg-location', ffmpeg,
      ...(potReady ? ['--plugin-dirs', potPlugin] : []),
      '-P', dir, '-o', 'download.%(ext)s', ...formats[format],
      ...(youtubeClients ? ['--extractor-args', `youtube:player_client=${youtubeClients}`] : []),
      '--', url,
    ]
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => { child.kill(); finish(new Error('El video tardó demasiado en procesarse.')) }, isYoutube ? 45000 : 120000)
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
    child.on('error', finish)
    child.on('close', code => finish(code === 0 ? null : new Error(stderr.trim() || 'No se pudo procesar el enlace.')))
  })
}

function runGallery(url, dir) {
  return new Promise((resolve, reject) => {
    const args = ['-m', 'gallery_dl', '--config-ignore', '--no-input', '-D', dir, url]
    const child = spawn('python3', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONPATH: path.join(root, 'vendor') } })
    let stderr = ''
    let settled = false
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve() }
    const timer = setTimeout(() => { child.kill(); finish(new Error('Las imágenes tardaron demasiado en procesarse.')) }, 120000)
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000) })
    child.on('error', finish)
    child.on('close', code => finish(code === 0 ? null : new Error(stderr.trim().split('\n').at(-1) || 'No se pudieron extraer las imágenes.')))
  })
}

function packImages(dir, files) {
  return new Promise((resolve, reject) => {
    const archive = path.join(dir, 'download.zip')
    const child = spawn('zip', ['-q', '-j', archive, ...files], { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(archive) : reject(new Error('No se pudo empaquetar la galería.')))
  })
}

function downloadedImages(dir) {
  const found = []
  const scan = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) scan(file)
      else if (entry.isFile() && /\.(jpg|jpeg|png|webp)$/i.test(entry.name)) found.push(file)
      if (found.length > 50) throw new Error('Esta publicación tiene más de 50 imágenes; descarga una galería más pequeña.')
    }
  }
  scan(dir)
  return found
}

async function bodyJson(req) {
  let text = ''
  for await (const chunk of req) {
    text += String(chunk)
    if (text.length > 4096) throw new Error('Solicitud demasiado grande.')
  }
  return JSON.parse(text || '{}')
}

export const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://localhost')
  const { pathname } = requestUrl
  if (pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true, engine: existsSync(binary) && existsSync(ffmpeg), gallery: existsSync(path.join(root, 'vendor', 'gallery_dl')), revision: '2026-11-12-download-v3' })
  const origin = String(req.headers.origin || '')
  const isFileDownload = req.method === 'GET' && /^\/api\/dl\/file\/[a-f0-9-]{36}$/.test(pathname)
  if (origin && !cors(res, origin)) return json(res, 403, { error: 'Origen no permitido.' })
  if (!origin && !isFileDownload) return json(res, 403, { error: 'Origen no permitido.' })
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  if (pathname === '/api/dl/prepare' && req.method === 'POST') {
    if (!existsSync(binary) || !existsSync(ffmpeg)) return json(res, 503, { error: 'El motor de descarga todavía no está listo.' })
    let dir
    let reserved = false
    let requestKey
    let ownsPreparation = false
    try {
      const body = await bodyJson(req)
      let url = String(body.url || '')
      const platform = sourcePlatform(url)
      let format = String(body.format || '')
      const isPhoto = platform === 'tiktok' && /\/photo\/\d+/.test(new URL(url).pathname)
      if (platform === 'tiktok' && !isPhoto && format !== 'audio') format = 'video'
      if (isPhoto) format = 'photos'
      if (platform === 'instagram' && format !== 'audio' && format !== 'jpg') format = 'video'
      if (platform === 'pinterest' && format !== 'image') format = 'video'
      if (!platform || !Object.hasOwn(formats, format)) return json(res, 400, { error: 'Usa un enlace público HTTPS de TikTok, Instagram o Pinterest.' })
      const canonical = new URL(url)
      canonical.hash = ''
      for (const parameter of ['utm_source', 'utm_medium', 'utm_campaign', 'si', 'igsh', 'list', 'start_radio']) canonical.searchParams.delete(parameter)
      url = canonical.href
      const key = JSON.stringify([url, format])
      requestKey = key
      const failed = failures.get(key)
      if (failed && failed.until > Date.now()) return json(res, 422, { error: failed.message })
      failures.delete(key)
      const lookup = () => {
        const token = prepared.get(key)
        const job = token && jobs.get(token)
        return job ? { token, size: job.size, filename: job.downloadName } : null
      }
      const cached = lookup()
      if (cached) return json(res, 200, cached)
      if (preparing.has(key)) {
        const deadline = Date.now() + 145000
        while (preparing.has(key) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200))
        const ready = lookup()
        if (ready) return json(res, 200, ready)
        const previousError = failures.get(key)
        if (previousError && previousError.until > Date.now()) return json(res, 422, { error: previousError.message })
        return json(res, 503, { error: 'No se pudo preparar este archivo. Inténtalo otra vez.' })
      }
      const galleryMode = format === 'image' || format === 'photos'
      if (galleryMode && !existsSync(path.join(root, 'vendor', 'gallery_dl'))) return json(res, 503, { error: 'El motor de imágenes todavía no está instalado.' })
      preparing.add(key)
      ownsPreparation = true
      await reserveSlot()
      reserved = true
      const reused = lookup()
      if (reused) return json(res, 200, reused)
      dir = mkdtempSync(path.join(tmpdir(), 'deyvit-dl-'))
      if (galleryMode) await runGallery(url, dir)
      else {
        // These clients are recommended by the token provider when default
        // clients fail before the PO token can be generated.
        await runDownload(url, format, dir)
      }
      const imageFiles = galleryMode ? downloadedImages(dir) : []
      const filename = galleryMode ? imageFiles.length === 1 ? imageFiles[0] : imageFiles.length > 1 ? await packImages(dir, imageFiles) : '' : readdirSync(dir).find(name => /^download\.(mp4|mkv|webm|mp3|m4a|jpg|jpeg)$/i.test(name))
      if (!filename) throw new Error('La plataforma no entregó un archivo descargable.')
      const file = path.isAbsolute(filename) ? filename : path.join(dir, filename)
      const size = statSync(file).size
      if (size < 1024) throw new Error('La plataforma entregó un archivo vacío.')
      const id = randomUUID()
      const timer = setTimeout(() => expire(id), 3 * 60000)
      const shortPlatform = { tiktok: 'tt', instagram: 'ig', pinterest: 'pin' }[platform]
      const downloadName = `dei v ${shortPlatform}${path.extname(file)}`
      jobs.set(id, { dir, file, size, timer, downloadName, format, key })
      prepared.set(key, id)
      while (jobs.size > 6 || (jobs.size > 1 && [...jobs.values()].reduce((total, job) => total + job.size, 0) > 180 * 1024 * 1024)) {
        const candidate = [...jobs.entries()].find(([candidate, job]) => candidate !== id && !job.readers)?.[0]
        if (!candidate) break
        expire(candidate)
      }
      dir = undefined
      return json(res, 200, { token: id, size, filename: downloadName })
    } catch (error) {
      if (requestKey) {
        if (failures.size >= 100) failures.delete(failures.keys().next().value)
        const blocked = /sign in|not a bot|login required|verification|403/i.test(String(error))
        failures.set(requestKey, { until: Date.now() + (blocked ? 60000 : 10000), message: errorMessage(error) })
      }
      if (/pinterest_.*\.mp4/i.test(String(error))) {
        return json(res, 422, { error: 'Este pin contiene un video. Elige MP4.' })
      }
      return json(res, 422, { error: errorMessage(error) })
    } finally {
      if (ownsPreparation) preparing.delete(requestKey)
      if (reserved) releaseSlot()
      if (dir) removeTemp(dir)
    }
  }

  const match = pathname.match(/^\/api\/dl\/file\/([a-f0-9-]{36})$/)
  if (match && req.method === 'GET') {
    const job = jobs.get(match[1])
    if (!job) return json(res, 404, { error: 'La descarga expiró. Prepárala otra vez.' })
    const extension = path.extname(job.file).toLowerCase()
    const mime = extension === '.mp3' ? 'audio/mpeg' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : extension === '.zip' ? 'application/zip' : extension === '.m4a' ? 'audio/mp4' : extension === '.webm' ? job.format === 'audio-best' ? 'audio/webm' : 'video/webm' : 'video/mp4'
    const customName = (requestUrl.searchParams.get('name') || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().replace(/^\.+|[. ]+$/g, '').slice(0, 80)
    const filename = customName ? customName + extension : job.downloadName
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': job.size,
      'Content-Disposition': `attachment; filename="${job.downloadName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    job.readers = (job.readers || 0) + 1
    res.once('close', () => { job.readers = Math.max(0, job.readers - 1) })
    createReadStream(job.file).on('error', () => res.destroy()).pipe(res)
    return
  }
  json(res, 404, { error: 'Ruta no encontrada.' })
})

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, '0.0.0.0', () => console.log(`Descargas directas listas en puerto ${port}`))
}

