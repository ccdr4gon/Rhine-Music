import test from 'node:test'
import assert from 'node:assert/strict'
import { MusicPlayer } from '../src/local_music/connector/music-player.ts'

const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }

/** No browser, network, real timers, or actual sound is used by these tests. */
function environment(t) {
  let now = 0
  let nextTimer = 1
  const timers = new Map()
  const instances = []
  const document = new EventTarget()
  const previousAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousTimeout = globalThis.setTimeout
  const previousClear = globalThis.clearTimeout
  const previousNow = Object.getOwnPropertyDescriptor(performance, 'now')
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  // Songs whose files cannot be decoded, and those the service no longer has (its /api/audio 404s).
  const unreadable = new Set()
  const missing = new Set()
  const song = (id) => instances.findLast((audio) => audio.src === `/api/audio/${encodeURIComponent(id)}`)

  class ControlledAudio extends EventTarget {
    constructor(src = '') {
      super()
      this.src = src
      this.volume = 1
      this.paused = true
      this.ended = false
      this.error = null
      this.duration = 120
      this.currentTime = 0
      this.readyState = 1
      this.playCalls = 0
      this.deferred = []
      this.holdPlay = false
      instances.push(this)
    }

    play() {
      this.playCalls += 1
      // As Chromium reports a file it cannot read (a 404 too): MEDIA_ERR_SRC_NOT_SUPPORTED, then the play is rejected.
      const id = decodeURIComponent(this.src.replace('/api/audio/', ''))
      if (unreadable.has(id) || missing.has(id)) {
        this.error = { code: 4 }
        queueMicrotask(() => this.dispatchEvent(new Event('error')))
        return Promise.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'))
      }
      if (this.holdPlay) {
        this.holdPlay = false
        return new Promise((resolve) => this.deferred.push(() => { this.begin(); resolve() }))
      }
      this.begin()
      return Promise.resolve()
    }

    begin() {
      this.paused = false
      this.dispatchEvent(new Event('playing'))
    }

    resolvePlay() {
      assert.ok(this.deferred.length, 'there must be a held audio play request')
      this.deferred.shift()()
    }

    pause() {
      if (this.paused) return
      this.paused = true
      this.dispatchEvent(new Event('pause'))
    }

    /** Plays to its end: paused and ended, then its 'ended' event. */
    finish() {
      this.currentTime = this.duration
      this.paused = true
      this.ended = true
      this.dispatchEvent(new Event('ended'))
    }

    removeAttribute(name) { if (name === 'src') this.src = '' }
    load() {}
  }

  Object.defineProperty(globalThis, 'Audio', { configurable: true, writable: true, value: ControlledAudio })
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document })
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = nextTimer++
    timers.set(id, { callback, at: now + Number(delay) })
    return id
  }
  globalThis.clearTimeout = (id) => timers.delete(id)
  // Only the player's HEAD request for a song that could not be read.
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (url, init) => {
    assert.equal(init?.method, 'HEAD')
    return { status: missing.has(decodeURIComponent(String(url).replace('/api/audio/', ''))) ? 404 : 200 }
  } })
  t.after(() => {
    if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch)
    else delete globalThis.fetch
    if (previousAudio) Object.defineProperty(globalThis, 'Audio', previousAudio)
    else delete globalThis.Audio
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete globalThis.document
    if (previousNow) Object.defineProperty(performance, 'now', previousNow)
    else delete performance.now
    globalThis.setTimeout = previousTimeout
    globalThis.clearTimeout = previousClear
  })

  return {
    instances,
    unreadable,
    missing,
    song,
    gesture: () => document.dispatchEvent(new Event('pointerdown')),
    pendingTimers: () => timers.size,
    async advance(milliseconds) {
      await settle()
      const end = now + milliseconds
      let next
      while ((next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0])) {
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await settle()
      }
      now = end
      await settle()
    },
  }
}

const track = (id) => ({ id, albumId: 'album-test', title: id, artist: 'Test artist', duration: 120, format: 'WAV', browserPlayable: true, relativePath: `${id}.wav`, audioUrl: `/api/audio/${id}` })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.0001, `expected ${actual} ≈ ${expected}`)

test('BGM has an independent default, live volume, zero-volume gate, and clamped settings', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0 })
  const bgm = env.instances[0]
  assert.equal(player.state.songFadeEnabled, true)
  assert.equal(player.state.bgmVolume, 0.18)
  assert.equal(bgm.playCalls, 0, 'no autoplay before a gesture')
  env.gesture()
  await env.advance(700)
  near(bgm.volume, 0.18)
  assert.equal(player.state.bgmPlaying, true, 'muted songs do not mute the BGM')
  player.setVolume(1)
  await env.advance(700)
  near(bgm.volume, 0.18)
  player.setBgmVolume(0.42)
  await env.advance(700)
  near(bgm.volume, 0.42)
  assert.equal(player.state.volume, 1)
  player.setBgmVolume(NaN)
  assert.equal(player.state.bgmVolume, 0.42)
  player.setBgmVolume(-1)
  await env.advance(250)
  assert.equal(player.state.bgmVolume, 0)
  assert.equal(bgm.paused, true)
  assert.equal(player.state.bgmEnabled, true, 'zero volume preserves the independent enabled preference')
  player.setBgmVolume(9)
  await env.advance(700)
  assert.equal(player.state.bgmVolume, 1)
  near(bgm.volume, 1)
  player.dispose()
  assert.equal(env.pendingTimers(), 0)
})

test('song playback waits for BGM silence despite rapid BGM volume and toggle changes', async (t) => {
  const env = environment(t)
  // Isolate BGM timing from the optional song envelope in this transport check.
  const player = new MusicPlayer({ volume: 0.65, bgmVolume: 0.3, songFadeEnabled: false })
  player.setQueue([track('first')])
  env.gesture()
  await env.advance(700)
  const bgm = env.instances[0]
  const playing = player.play('first')
  const song = env.instances[1]
  await env.advance(96)
  assert.equal(song.playCalls, 0)
  assert.ok(bgm.volume > 0 && bgm.volume < 0.3)
  player.setBgmVolume(0.8)
  player.setBgmEnabled(false)
  player.setBgmEnabled(true)
  player.setVolume(0.25)
  await env.advance(100)
  assert.equal(song.playCalls, 0, 'controls must not bypass the shared fade-out promise')
  await env.advance(60)
  await playing
  assert.equal(song.playCalls, 1)
  assert.equal(song.volume, 0.25)
  assert.equal(bgm.volume, 0)
  assert.equal(bgm.paused, true)
  assert.equal(player.state.playing, true)
  assert.equal(player.state.bgmVolume, 0.8)
  player.setBgmVolume(0.4)
  await env.advance(700)
  assert.equal(song.volume, 0.25, 'BGM volume cannot alter song output')
  assert.equal(bgm.paused, true, 'BGM stays silent while a song plays')
  player.stop()
  await env.advance(700)
  near(bgm.volume, 0.4)
  assert.equal(player.state.bgmPlaying, true)
  player.dispose()
})

test('rapidly cancelling a pending song restores only the latest BGM volume', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ bgmVolume: 0.5 })
  player.setQueue([track('first')])
  env.gesture()
  await env.advance(700)
  const bgm = env.instances[0]
  const pending = player.play('first')
  const song = env.instances[1]
  await env.advance(72)
  player.stop()
  player.setBgmVolume(0.2)
  player.setBgmEnabled(false)
  await env.advance(24)
  player.setBgmEnabled(true)
  player.setBgmVolume(0.33)
  await env.advance(700)
  await pending
  assert.equal(song.playCalls, 0, 'cancelled song never starts after the old fade finishes')
  assert.equal(song.paused, true)
  near(bgm.volume, 0.33)
  assert.equal(player.state.bgmPlaying, true)
  assert.equal(player.state.playing, false)
  player.dispose()
  await env.advance(1000)
  assert.equal(bgm.paused, true)
  assert.equal(env.pendingTimers(), 0)
})

test('a late BGM play resolution stays silent when a song has taken over', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ bgmVolume: 0.4, songFadeEnabled: false })
  const bgm = env.instances[0]
  bgm.holdPlay = true
  player.setQueue([track('first')])
  env.gesture()
  await settle()
  assert.equal(bgm.playCalls, 1)
  const playing = player.play('first')
  await env.advance(250)
  await playing
  const song = env.instances[1]
  assert.equal(song.paused, false)
  bgm.resolvePlay()
  await settle()
  assert.equal(bgm.paused, true)
  assert.equal(bgm.volume, 0)
  assert.equal(player.state.bgmPlaying, false)
  assert.equal(player.state.playing, true)
  player.dispose()
})

test('a song the playlist moves on to that cannot be read is skipped, saying why; one asked for stops there', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0, songFadeEnabled: false })
  const said = []
  player.subscribe((state) => { if (state.error && said.at(-1) !== state.error) said.push(state.error) })
  // Fictional songs: a damaged file, then one moved away since the scan, then a good one.
  env.unreadable.add('Broken')
  env.missing.add('Moved')
  const playlist = [track('Alpha'), track('Broken'), track('Moved'), track('Delta')]
  await player.play('Alpha', playlist)
  await env.advance(10)
  assert.equal(player.state.transport, 'playing')
  env.song('Alpha').finish()
  await env.advance(10)
  assert.equal(player.state.currentTrack.id, 'Delta', 'the playlist goes on past both')
  assert.equal(player.state.transport, 'playing')
  assert.equal(env.song('Delta').paused, false)
  assert.deepEqual(said, [
    '无法播放「Broken」：当前浏览器不支持它的编码，或文件已损坏，已跳到下一首。',
    '找不到「Moved」的文件（可能已被移动或删除），已跳到下一首。',
  ])
  // The last song of the playlist could not be read: the player stops there, saying why.
  await player.play('Alpha', [track('Alpha'), track('Broken')])
  await env.advance(10)
  env.song('Alpha').finish()
  await env.advance(10)
  assert.equal(player.state.transport, 'error')
  assert.equal(player.state.currentTrack.id, 'Broken')
  assert.equal(player.state.error, '无法播放此 WAV 文件：当前浏览器不支持它的编码，或文件已损坏、不可读取。')
  // A song asked for (▶, P, a ring, the header's ‹ ›) stops there: the file that is gone is named so.
  await player.play('Moved', playlist)
  await env.advance(10)
  assert.equal(player.state.transport, 'error')
  assert.equal(player.state.currentTrack.id, 'Moved', 'never another song than the one asked for')
  assert.equal(player.state.error, '找不到这首歌的文件：它可能已被移动或删除，请重新扫描音乐库。')
  // A folder gone: the third song in a row that cannot be read stops the playlist.
  for (const id of ['Gone 1', 'Gone 2', 'Gone 3']) env.missing.add(id)
  await player.play('Alpha', [track('Alpha'), track('Gone 1'), track('Gone 2'), track('Gone 3'), track('Delta')])
  await env.advance(10)
  env.song('Alpha').finish()
  await env.advance(10)
  assert.equal(player.state.transport, 'error')
  assert.equal(player.state.currentTrack.id, 'Gone 3')
  assert.equal(env.song('Delta'), undefined, 'not tried')
  player.dispose()
})

// A scan applied in place (music-app.ts syncPlayerQueue): the playlist as the scan left it, the loaded
// song going on; a loaded song the library no longer has (another main folder) stops, without an error.
test('a new queue for the loaded song keeps it playing and goes on through the new one; without it, the player stops', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0, songFadeEnabled: false })
  const said = []
  player.subscribe((state) => { if (state.error) said.push(state.error) })
  await player.play('Alpha', [track('Alpha'), track('Gamma')])
  await env.advance(10)
  const alpha = env.song('Alpha')
  // A song added before the next one, with the loaded song's tags read again.
  player.setQueue([{ ...track('Alpha'), title: 'Alpha (new tags)' }, track('Beta'), track('Gamma')])
  assert.equal(player.state.transport, 'playing')
  assert.equal(player.state.currentTrack.title, 'Alpha (new tags)')
  assert.equal(alpha.paused, false, 'the same element plays on')
  assert.equal(env.song('Alpha'), alpha)
  alpha.finish()
  await env.advance(10)
  assert.equal(player.state.currentTrack.id, 'Beta', 'the added song plays in its turn')
  assert.equal(player.state.transport, 'playing')
  // The loaded song is gone from the library: it stops, idle; nothing of the old queue is tried.
  env.missing.add('Gamma')
  const beta = env.song('Beta')
  player.setQueue([])
  await env.advance(10)
  assert.equal(player.state.transport, 'idle')
  assert.equal(player.state.currentTrack, null)
  assert.equal(beta.paused, true)
  assert.equal(env.song('Gamma'), undefined, 'not tried')
  assert.deepEqual(said, [])
  player.dispose()
})

test('a song paused and resumed from outside the page (media keys) follows both', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0, songFadeEnabled: false })
  await player.play('first', [track('first')])
  await env.advance(10)
  const song = env.song('first')
  song.pause()
  assert.equal(player.state.transport, 'paused')
  // The system's play: the element's own, as Chromium's default media session action calls it.
  await song.play()
  await env.advance(10)
  assert.equal(player.state.transport, 'playing')
  assert.equal(song.paused, false, 'not paused again')
  await player.toggle()
  assert.equal(player.state.transport, 'paused')
  assert.equal(song.paused, true, 'the page still pauses it')
  player.dispose()
})

test('‹ after the playlist ended plays the song before; while one is loaded past 3 s it starts it again', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0, songFadeEnabled: false })
  const playlist = [track('one'), track('two')]
  await player.play('two', playlist)
  await env.advance(10)
  env.song('two').currentTime = 30
  env.song('two').dispatchEvent(new Event('timeupdate'))
  await player.previous()
  assert.equal(player.state.currentTrack.id, 'two', 'loaded: back to its start')
  assert.equal(env.song('two').currentTime, 0)
  env.song('two').finish()
  await env.advance(10)
  assert.equal(player.state.transport, 'idle')
  await player.previous()
  await env.advance(10)
  assert.equal(player.state.currentTrack.id, 'one', 'the first press plays the song before the last')
  assert.equal(player.state.transport, 'playing')
  player.dispose()
})

test('resuming a paused song that is at its very end goes on with the playlist, not from 0:00', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0, songFadeEnabled: false })
  await player.play('one', [track('one'), track('two')])
  await env.advance(10)
  await player.toggle()
  // Seeked to its end while paused: the element is ended, and no 'ended' event comes.
  const one = env.song('one')
  player.seek(120)
  one.ended = true
  await player.toggle()
  await env.advance(10)
  assert.equal(player.state.currentTrack.id, 'two')
  assert.equal(player.state.transport, 'playing')
  assert.equal(one.playCalls, 1, 'the ended song is not started again')
  // The last song: the player rests, as after a playlist that played to its end.
  await player.toggle()
  player.seek(120)
  env.song('two').ended = true
  await player.toggle()
  await env.advance(10)
  assert.equal(player.state.transport, 'idle')
  assert.equal(env.song('two').playCalls, 1)
  player.dispose()
})
