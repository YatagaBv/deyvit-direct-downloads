import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { server, sourcePlatform, convertVideoToMp3 } from './server.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('admite TikTok e Instagram públicos', () => {
  assert.equal(sourcePlatform('https://www.tiktok.com/@fundacionmaya.bo/video/7494380164235693317'), 'tiktok')
  assert.equal(sourcePlatform('https://www.instagram.com/reels/Dewd-4qNQ0T/'), 'instagram')
})

test('admite pins y publicaciones de fotos públicas', () => {
  assert.equal(sourcePlatform('https://es.pinterest.com/pin/1068971661536460645/'), 'pinterest')
  assert.equal(sourcePlatform('https://www.tiktok.com/@chillax_66/photo/7508442021644782866'), 'tiktok')
})

test('rechaza dominios falsos, puertos y rutas no admitidas', () => {
  assert.equal(sourcePlatform('https://www.youtube.com/watch?v=qm0ru2iBuB0'), null)
  assert.equal(sourcePlatform('https://youtube.com.evil.example/watch?v=qm0ru2iBuB0'), null)
  assert.equal(sourcePlatform('https://www.youtube.com:8443/watch?v=qm0ru2iBuB0'), null)
  assert.equal(sourcePlatform('https://www.instagram.com/evil'), null)
  assert.equal(sourcePlatform('http://www.tiktok.com/@x/video/123'), null)
  assert.equal(sourcePlatform('https://pinterest.com.evil.example/pin/123'), null)
})

test('el conversor solo acepta cuentas Google verificadas', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const options = await fetch(`${base}/api/music/extract`, { method: 'OPTIONS', headers: { Origin: 'https://deyvit-blog.surge.sh' } })
    assert.equal(options.status, 204)
    assert.match(options.headers.get('access-control-allow-headers') || '', /Authorization/)
    const response = await fetch(`${base}/api/music/extract`, { method: 'POST', headers: { Origin: 'https://deyvit-blog.surge.sh', 'Content-Type': 'video/mp4' }, body: Buffer.alloc(1024) })
    assert.equal(response.status, 401)
    assert.match((await response.json()).error, /Google/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('extrae audio MP3 reproducible de un video real', async t => {
  const available = spawnSync('ffmpeg', ['-version'], { windowsHide: true })
  if (available.status !== 0) return t.skip('FFmpeg no está instalado en este equipo de pruebas.')
  const dir = mkdtempSync(path.join(tmpdir(), 'music-convert-test-'))
  try {
    const input = path.join(dir, 'input.mp4'), output = path.join(dir, 'output.mp3')
    const generated = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', '-y', input], { windowsHide: true })
    assert.equal(generated.status, 0)
    await convertVideoToMp3(input, output, 'ffmpeg')
    assert.ok(statSync(output).size > 1000)
    assert.equal(readFileSync(output).subarray(0, 3).toString(), 'ID3')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

