import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { sourcePlatform } from './server.mjs'

test('admite los tres ejemplos enviados por el dueño', () => {
  assert.equal(sourcePlatform('https://www.youtube.com/watch?v=qm0ru2iBuB0'), 'youtube')
  assert.equal(sourcePlatform('https://www.tiktok.com/@fundacionmaya.bo/video/7494380164235693317'), 'tiktok')
  assert.equal(sourcePlatform('https://www.instagram.com/reels/Dewd-4qNQ0T/'), 'instagram')
})

test('admite pins y publicaciones de fotos públicas', () => {
  assert.equal(sourcePlatform('https://es.pinterest.com/pin/1068971661536460645/'), 'pinterest')
  assert.equal(sourcePlatform('https://www.tiktok.com/@chillax_66/photo/7508442021644782866'), 'tiktok')
})

test('rechaza dominios falsos, puertos y rutas no admitidas', () => {
  assert.equal(sourcePlatform('https://youtube.com.evil.example/watch?v=qm0ru2iBuB0'), null)
  assert.equal(sourcePlatform('https://www.youtube.com:8443/watch?v=qm0ru2iBuB0'), null)
  assert.equal(sourcePlatform('https://www.instagram.com/evil'), null)
  assert.equal(sourcePlatform('http://www.tiktok.com/@x/video/123'), null)
  assert.equal(sourcePlatform('https://pinterest.com.evil.example/pin/123'), null)
})

