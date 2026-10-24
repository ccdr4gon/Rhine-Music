import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseFile } from 'music-metadata'
import { AlbumIntroductionProvider } from './album-introductions.mjs'

const AUDIO_EXTENSIONS = new Set(['.flac', '.wav', '.m4a', '.mp4', '.alac', '.dsf', '.dff', '.mp3', '.aac', '.aiff', '.aif', '.ogg', '.opus'])
const BROWSER_EXTENSIONS = new Set(['.flac', '.wav', '.m4a', '.mp4', '.mp3', '.aac', '.ogg', '.opus'])
const MBID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const unique = (items) => [...new Set(items.filter(Boolean))]
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24)
const text = (value) => typeof value === 'string' ? value.trim() : ''
const normalized = (value) => text(value).normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
const exists = async (file) => { try { await fs.access(file); return true } catch { return false } }
const timestamp = () => new Date().toISOString()
const METADATA_VERSION = 2
// An .lrc larger than this is not lyrics (ordinary ones have a few kilobytes).
const MAX_LYRICS_BYTES = 512 * 1024
const lrcStamp = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`
// ID3v2 synchronised lyrics as LRC text, as the client's reader writes them (metadata.rs): a part that
// starts with a line break starts a line and the others in it are timed words; without such breaks
// each part is a line.
function syncedLrc(parts) {
  const breaks = (value) => /^[\r\n]/.test(value)
  const marked = parts.slice(1).some((part) => breaks(String(part?.text ?? '')))
  const lines = []
  for (const part of parts) {
    const words = String(part?.text ?? ''), time = Math.max(0, Number(part?.timestamp) || 0)
    if (!lines.length || !marked || breaks(words)) lines.push([])
    lines.at(-1).push([time, words.replace(/^[\r\n]+/, '')])
  }
  // Timed parts without words make a pause, not stamps alone.
  const lrc = lines.map((line) => `[${lrcStamp(line[0][0])}]${line.length === 1 ? line[0][1].trimEnd() : line.every(([, words]) => !words.trim()) ? '' : line.map(([time, words]) => `<${lrcStamp(time)}>${words}`).join('').trimEnd()}`).join('\n')
  return lrc.trim() ? lrc : ''
}
// The tags whose text is lyrics (native ids, compared in capitals): ID3v2 USLT, Vorbis LYRICS and
// UNSYNCEDLYRICS, MP4 ©lyr, APE Lyrics.
const LYRIC_TAGS = new Set(['USLT', 'LYRICS', 'UNSYNCEDLYRICS', '©LYR'])
// QQ Music's encrypted downloads (.mflac, .mgg, .qmc* and their numbered variants): not audio this
// service can read, never decrypted; only counted for the scan's summary (as library.rs does).
const ENCRYPTED_DOWNLOAD = /^\.(?:qmc|mflac|mgg)/i

const codePoints = (value) => Array.from(value, (char) => char.codePointAt(0))
const isDigit = (code) => code >= 48 && code <= 57
/** Code point order (Rust's string order). */
export function codePointCompare(left, right) {
  const a = codePoints(left), b = codePoints(right)
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return Math.sign(a.length - b.length)
}
/** Natural order, exactly as library.rs natural_cmp: case folded, runs of ASCII digits by value. */
export function naturalCompare(left, right) {
  const a = codePoints(left.toLowerCase()), b = codePoints(right.toLowerCase())
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (isDigit(a[i]) && isDigit(b[j])) {
      let x = ''
      let y = ''
      while (i < a.length && isDigit(a[i])) x += String.fromCodePoint(a[i++])
      while (j < b.length && isDigit(b[j])) y += String.fromCodePoint(b[j++])
      x = x.replace(/^0+/, '')
      y = y.replace(/^0+/, '')
      const order = x.length - y.length || codePointCompare(x, y)
      if (order) return Math.sign(order)
    } else {
      if (a[i] !== b[j]) return a[i] < b[j] ? -1 : 1
      i++
      j++
    }
  }
  return (i < a.length ? 1 : 0) - (j < b.length ? 1 : 0)
}
const pathParts = (value) => value.split(/[\\/]/).filter(Boolean)
/** Natural order of two paths inside the main folder, folder by folder (library.rs path_cmp). */
export function pathCompare(left, right) {
  const a = pathParts(left), b = pathParts(right)
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = naturalCompare(a[i], b[i]) || codePointCompare(a[i], b[i])
    if (order) return order
  }
  return Math.sign(a.length - b.length)
}

/**
 * The main folder's playlists (the owner, 2026-10-06), as library.rs `playlists` makes them: each
 * direct subfolder holding audio at any depth, named after it, its songs in natural order of their
 * paths; the main folder's own audio first, named after the main folder.
 */
export function folderPlaylists(main, albums) {
  const lists = new Map()
  for (const album of albums) for (const track of album.tracks) {
    const parts = pathParts(track.relativePath ?? '')
    const nested = parts.length > 1
    const folder = nested ? path.join(main, parts[0]) : main
    let list = lists.get(folder)
    if (!list) lists.set(folder, list = { name: nested ? parts[0] : path.basename(main) || main, folder, main: !nested, songs: [] })
    list.songs.push(track)
  }
  return [...lists.values()]
    .map((list) => ({ ...list, songs: list.songs.sort((a, b) => pathCompare(a.relativePath, b.relativePath) || codePointCompare(a.id, b.id)) }))
    .sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0) || naturalCompare(a.name, b.name) || codePointCompare(a.name, b.name) || codePointCompare(a.folder, b.folder))
    .map((list) => ({ id: `playlist-${hash(list.folder)}`, name: list.name, folder: list.folder, main: list.main, trackIds: list.songs.map((track) => track.id) }))
}

export const DEFAULT_RULES = {
  version: 1,
  genres: [
    { id: 'mandopop', name: '华语流行', aliases: ['Mandopop', '国语流行音乐', '华语流行音乐', '华语流行', '国语流行', 'Chinese Pop'] },
    { id: 'pop', name: '流行', aliases: ['Pop', '流行音乐'] },
    { id: 'rock', name: '摇滚', aliases: ['Rock', '摇滚音乐'] },
    { id: 'jazz', name: '爵士', aliases: ['Jazz', '爵士乐'] },
    { id: 'classical', name: '古典', aliases: ['Classical', '古典音乐'] },
    { id: 'electronic', name: '电子', aliases: ['Electronic', 'Electronica', '电子音乐'] },
    { id: 'ambient', name: '氛围', aliases: ['Ambient', '氛围音乐'] },
    { id: 'soundtrack', name: '原声', aliases: ['Soundtrack', 'OST', '原声音乐', '电影原声'] },
    { id: 'unclassified', name: '未分类', aliases: [] },
  ],
  albumOverrides: {},
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

// JSON text without a byte order mark, which an editor may put before it.
const withoutBom = (text) => text.replace(/^\uFEFF/, '')

async function readJson(file, fallback) {
  try { return JSON.parse(withoutBom(await fs.readFile(file, 'utf8'))) }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw new Error(`无法读取 ${file}: ${error.message}`) }
}

/**
 * One of the store's data files as read at a start, if it is there and `valid` takes it (as
 * library.rs `load`). A file this version cannot read (not JSON, say after a power cut, or of a shape
 * it does not know, say written by a newer version) is set aside beside it as
 * `<name>.unreadable-<UTC time>`, never deleted or written over, and the start goes on without it
 * (undefined); its new name is added to `setAside`. Only an error reading the data folder itself stops the start.
 */
async function loadData(file, valid, setAside) {
  let text
  try { text = await fs.readFile(file, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error(`无法读取 ${file}: ${error.message}`) }
  try {
    const value = JSON.parse(withoutBom(text))
    if (valid(value)) return value
  } catch {}
  const stamp = new Date().toISOString().replace(/[-:]/g, '')
  let aside = `${path.basename(file)}.unreadable-${stamp}`
  for (let n = 2; await exists(path.join(path.dirname(file), aside)); n++) aside = `${path.basename(file)}.unreadable-${stamp}-${n}`
  await fs.rename(file, path.join(path.dirname(file), aside))
  setAside.push(aside)
  return undefined
}
const succeeds = (task) => { try { task(); return true } catch { return false } }

export function validateRules(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.genres) || value.genres.length > 1000 || !value.albumOverrides || typeof value.albumOverrides !== 'object' || Array.isArray(value.albumOverrides)) throw new Error('流派规则需要 version:1、genres 数组和 albumOverrides 对象')
  const ids = new Set()
  const genres = value.genres.map((genre) => {
    if (!genre || typeof genre.id !== 'string' || !/^[\w-]{1,100}$/.test(genre.id) || ids.has(genre.id) || !text(genre.name) || (genre.aliases !== undefined && (!Array.isArray(genre.aliases) || genre.aliases.some((alias) => typeof alias !== 'string')))) throw new Error('流派 ID 必须唯一，名称和别名必须为文本')
    ids.add(genre.id)
    return { id: genre.id, name: text(genre.name), aliases: unique((genre.aliases ?? []).map(text)) }
  })
  if (!ids.has('unclassified')) genres.push({ id: 'unclassified', name: '未分类', aliases: [] })
  ids.add('unclassified')
  const albumOverrides = {}
  for (const [id, genreId] of Object.entries(value.albumOverrides)) {
    if (!ids.has(genreId)) throw new Error(`专辑 ${id} 的人工流派 ${genreId} 不存在`)
    Object.defineProperty(albumOverrides, id, { value: genreId, enumerable: true, writable: true, configurable: true })
  }
  return { version: 1, genres, albumOverrides }
}

export function resolveGenre(album, rules) {
  const override = Object.hasOwn(rules.albumOverrides, album.id) ? rules.albumOverrides[album.id] : undefined
  if (override && rules.genres.some((genre) => genre.id === override)) return override
  const inputs = unique([...(album._onlineGenres ?? []), ...(album._localGenres ?? album.rawGenres ?? [])])
  for (const input of inputs) {
    const target = normalized(input)
    const match = rules.genres.find((genre) => [genre.name, genre.id, ...(genre.aliases ?? [])].some((alias) => normalized(alias) === target))
    if (match) return match.id
  }
  return inputs.length ? `source-${hash(normalized(inputs[0]))}` : 'unclassified'
}

export function safeRootList(roots) {
  if (!Array.isArray(roots) || roots.length > 64 || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || (process.platform === 'win32' && path.parse(root).root.length <= 1))) throw new Error('音乐目录必须是绝对路径数组（最多 64 个）；Windows 请包含盘符，例如 D:\\Music')
  // The first folder is the main folder (2026-10-06): always kept, first. A later folder that is
  // the same, lies inside a kept one or contains the main folder is dropped; a later folder
  // replaces the ones inside it. Folders after the main one come from earlier versions: kept, unused.
  const inside = (parent, child) => {
    const relative = path.relative(parent, child)
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }
  const output = []
  for (const root of unique(roots.map((root) => path.resolve(root)))) {
    if (output.some((kept) => inside(kept, root)) || (output.length && inside(root, output[0]))) continue
    for (let index = output.length - 1; index >= 1; index--) if (inside(root, output[index])) output.splice(index, 1)
    output.push(root)
  }
  return output
}

function audioMime(file) {
  return ({ '.flac': 'audio/flac', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aiff': 'audio/aiff', '.aif': 'audio/aiff' })[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function imageMime(file) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Main-folder files are one record each; nested folders with audio are album records (their songs,
 * cover and introduction). The playlists are made from these records' paths (folderPlaylists).
 * Names starting with a dot are skipped (macOS's `._` copies included); this service cannot see
 * Windows' hidden attribute, which the Windows client also skips. Source files stay read-only.
 * Only the main folder itself failing fails the walk: a folder inside it that cannot be listed now
 * is counted in `skipped.unreadable` and kept in `skipped.folders` (its albums stay, scan), as are
 * QQ Music's encrypted downloads in `skipped.encrypted` (as library.rs walk).
 */
async function walkAlbums(root, skipped) {
  const folders = []
  const visit = async (folder) => {
    let entries
    try { entries = await fs.readdir(folder, { withFileTypes: true }) }
    catch (error) {
      if (folder === root) throw error
      // Gone since its parent was listed: deleted (a name that is not valid Unicode only seems gone, readAlbum).
      if (error.code === 'ENOENT' && !folder.includes('\uFFFD')) return
      skipped.unreadable += 1
      skipped.folders.push(folder)
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    skipped.encrypted += files.filter((entry) => ENCRYPTED_DOWNLOAD.test(path.extname(entry.name))).length
    const tracks = files.filter((entry) => AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())).map((entry) => path.join(folder, entry.name))
    if (tracks.length) {
      const images = files.filter((entry) => /\.(png|jpe?g|webp)$/i.test(entry.name))
      const preferred = ['cover', 'folder', 'front']
      images.sort((a, b) => {
        const rank = (entry) => { const value = preferred.indexOf(path.parse(entry.name).name.toLowerCase()); return value < 0 ? 99 : value }
        return rank(a) - rank(b) || a.name.localeCompare(b.name)
      })
      if (folder === root) {
        for (const file of tracks) {
          const name = path.parse(file).name.normalize('NFC').toLocaleLowerCase()
          const image = images.find((entry) => path.parse(entry.name).name.normalize('NFC').toLocaleLowerCase() === name)
          folders.push({ folder, tracks: [file], singleFile: file, cover: image ? path.join(folder, image.name) : undefined })
        }
      } else {
        folders.push({ folder, tracks, cover: images[0] ? path.join(folder, images[0].name) : undefined })
      }
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) await visit(path.join(folder, entry.name))
  }
  await visit(root)
  return folders
}
const insidePath = (parent, child) => {
  const relative = path.relative(parent, child)
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const albumEntryId = (entry) => `album-${hash(entry.singleFile ?? entry.folder)}`
const firstString = (value) => Array.isArray(value) ? text(value[0]) : text(value)
const numberOrUndefined = (value) => Number.isFinite(value) && value > 0 ? value : undefined

export class MusicLibraryStore {
  constructor({ dataDir, defaultRoots = [], metadataParser = parseFile, fetcher = globalThis.fetch, musicBrainzContact = process.env.MUSICBRAINZ_CONTACT, introductionProvider, onChange = () => {} }) {
    this.dataDir = path.resolve(dataDir)
    this.defaultRoots = defaultRoots
    this.parseFile = metadataParser
    this.fetcher = fetcher
    this.musicBrainzContact = musicBrainzContact
    this.environmentContact = musicBrainzContact
    this.onChange = onChange
    this.config = { version: 1, roots: [], onlineEnabled: false, foobarBaseUrl: null }
    this.index = { version: 1, albums: [], roots: [], scannedAt: null }
    this.rules = structuredClone(DEFAULT_RULES)
    this.scanStatus = { running: false }
    this.enrichStatus = { running: false, completed: 0, total: 0 }
    this.introductionsStatus = { running: false, completed: 0, total: 0, updated: 0, notFound: 0, failed: 0 }
    this.introductionProvider = introductionProvider ?? new AlbumIntroductionProvider({ fetcher, contact: () => this.musicBrainzContact })
    this.lastMusicBrainzRequest = 0
    this.saveChain = Promise.resolve()
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true })
    // A data folder that cannot be written stops the start (as library.rs Store::open): a start on one
    // that already holds valid data writes nothing else here. A file of its own, removed again.
    const probe = path.join(this.dataDir, `.write-test-${randomUUID()}.tmp`)
    try { await fs.writeFile(probe, '\n', { flag: 'wx' }) } finally { await fs.rm(probe, { force: true }).catch(() => {}) }
    // A data file this version cannot read is set aside and the start goes on without it (loadData).
    this.setAside = []
    const saved = await loadData(path.join(this.dataDir, 'config.json'), (config) => !!config && typeof config === 'object' && !Array.isArray(config) && succeeds(() => safeRootList(config.roots)), this.setAside)
    this.config = structuredClone(saved) ?? { ...this.config, roots: safeRootList(this.defaultRoots) }
    this.musicBrainzContact = this.config.musicBrainzContact || this.environmentContact
    this.config.roots = safeRootList(this.config.roots)
    this.index = await loadData(path.join(this.dataDir, 'library-index.json'), (index) => index?.version === 1 && Array.isArray(index.albums) && index.albums.every((album) => album && typeof album === 'object' && Array.isArray(album.tracks) && album.tracks.every((track) => track && typeof track === 'object')), this.setAside) ?? this.index
    this.rules = validateRules(await loadData(path.join(this.dataDir, 'genre-rules.json'), (rules) => succeeds(() => validateRules(rules)), this.setAside) ?? DEFAULT_RULES)
    if (!(await exists(path.join(this.dataDir, 'genre-rules.json')))) await writeJsonAtomic(path.join(this.dataDir, 'genre-rules.json'), this.rules)
    // Written when it is new or was cleaned, not at every start.
    if (!isDeepStrictEqual(saved, this.config)) await writeJsonAtomic(path.join(this.dataDir, 'config.json'), this.config)
    return this
  }

  /** The main folder: the first saved folder. Only it is scanned, shown and served. */
  get mainFolder() { return this.config.roots[0] }

  inLibrary(album) { return !!this.mainFolder && album._root === this.mainFolder }

  saveIndex() {
    // Serialize snapshots so an enrichment finishing during a scan cannot leave
    // an older snapshot on disk after a newer one has been written.
    const snapshot = structuredClone(this.index)
    this.saveChain = this.saveChain.catch(() => {}).then(() => writeJsonAtomic(path.join(this.dataDir, 'library-index.json'), snapshot))
    return this.saveChain
  }

  async reloadRules() {
    this.rules = validateRules(await readJson(path.join(this.dataDir, 'genre-rules.json'), DEFAULT_RULES))
  }

  async updateRules(value) {
    const rules = validateRules(value)
    const file = path.join(this.dataDir, 'genre-rules.json')
    if (await exists(file)) await fs.copyFile(file, `${file}.backup`)
    await writeJsonAtomic(file, rules)
    this.rules = rules
    this.onChange()
    return rules
  }

  /**
   * A new main folder has to be a folder that is there (as library.rs update_config): a mistyped one
   * neither replaces the chosen one nor is scanned as an empty library. The chosen one may be away (a
   * drive not connected): saved again, it keeps its index, offline.
   */
  async checkMainFolder(roots) {
    const main = roots[0]
    const key = (folder) => process.platform === 'win32' ? folder.replaceAll('/', '\\').toLowerCase() : folder
    if (main === undefined || (this.mainFolder !== undefined && key(main) === key(this.mainFolder))) return
    let stat
    try { stat = await fs.stat(main) }
    catch (error) { throw new Error(error.code === 'ENOENT' ? `找不到文件夹：${main}。音乐主文件夹保持不变。` : `无法打开文件夹 ${main}：${error.message}。音乐主文件夹保持不变。`) }
    if (!stat.isDirectory()) throw new Error(`不是文件夹：${main}。音乐主文件夹保持不变。`)
  }

  async updateConfig(value) {
    const next = { ...this.config }
    if (value.roots !== undefined) {
      next.roots = safeRootList(value.roots)
      await this.checkMainFolder(next.roots)
    }
    if (value.onlineEnabled !== undefined) {
      if (typeof value.onlineEnabled !== 'boolean') throw new Error('onlineEnabled 必须为布尔值')
      next.onlineEnabled = value.onlineEnabled
    }
    if (value.musicBrainzContact !== undefined) {
      if (typeof value.musicBrainzContact !== 'string' || value.musicBrainzContact.length > 500 || /[\r\n]/.test(value.musicBrainzContact)) throw new Error('MusicBrainz 联系方式必须是邮箱或项目网址')
      const contact = value.musicBrainzContact.trim()
      if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !/^https?:\/\/\S+$/.test(contact)) throw new Error('请输入有效的联系邮箱或 http(s) 项目网址')
      next.musicBrainzContact = contact
    }
    if (value.foobarBaseUrl !== undefined) {
      if (!value.foobarBaseUrl) next.foobarBaseUrl = null
      else {
        const url = new URL(value.foobarBaseUrl)
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('foobar 仅允许本机 HTTP 地址，例如 http://127.0.0.1:8880')
        next.foobarBaseUrl = url.origin
      }
    }
    await writeJsonAtomic(path.join(this.dataDir, 'config.json'), next)
    this.config = next
    this.musicBrainzContact = next.musicBrainzContact || this.environmentContact
    return next
  }

  snapshot() {
    const counts = new Map()
    const generated = new Map()
    const library = this.index.albums.filter((album) => this.inLibrary(album))
    const albums = library.map((album) => {
      const genreId = resolveGenre(album, this.rules)
      counts.set(genreId, (counts.get(genreId) ?? 0) + 1)
      if (genreId.startsWith('source-')) generated.set(genreId, { id: genreId, name: album._onlineGenres?.[0] ?? album._localGenres?.[0] ?? album.rawGenres[0] })
      return {
        id: album.id, title: album.title, artist: album.artist, year: album.year, discCount: album.discCount,
        description: album.descriptionSource?.url ? album.description : undefined, descriptionSource: album.descriptionSource?.url ? album.descriptionSource : undefined,
        localNote: album.localNote,
        introduction: album.introduction,
        genreId, rawGenres: unique([...(album._onlineGenres ?? []), ...(album._localGenres ?? [])]),
        folder: album.folder, coverUrl: album._cover ? `/api/artwork/${album.id}?v=${album._cover.version}` : undefined,
        // A song's own album and year tags come along for its details (as library.rs public_track).
        tracks: album.tracks.map(({ _path, _fingerprint, _common, _embeddedCover, _metadataVersion, ...track }) => ({
          ...track, ...(text(_common?.album) ? { album: text(_common.album) } : {}), ...(numberOrUndefined(_common?.year) ? { year: _common.year } : {}),
        })),
        producers: album.producers ?? [], offline: !!album.offline,
        online: album.online ?? { status: 'unqueried' },
      }
    })
    const genres = [...this.rules.genres, ...generated.values()].filter((genre) => counts.has(genre.id)).map((genre) => ({ ...genre, albumCount: counts.get(genre.id) ?? 0 }))
    return {
      version: 1, albums, genres, playlists: this.mainFolder ? folderPlaylists(this.mainFolder, library) : [],
      roots: this.config.roots.map((root) => this.index.roots.find((entry) => entry.path === root) ?? { path: root, status: 'unscanned' }),
      scan: { ...this.scanStatus }, onlineEnabled: !!this.config.onlineEnabled, enrich: { ...this.enrichStatus },
      introductions: { ...this.introductionsStatus },
      ...(this.setAside?.length ? { setAside: [...this.setAside] } : {}),
    }
  }

  async scan({ roots } = {}) {
    if (this.scanPromise) return this.scanPromise
    this.scanStatus = { running: true, startedAt: timestamp() }
    this.scanPromise = (async () => {
      try {
        if (roots !== undefined) await this.updateConfig({ roots })
        await this.reloadRules()
        const nextAlbums = []
        const nextRoots = []
        // Only the main folder: the folders earlier versions saved after it are not scanned.
        for (const root of this.config.roots.slice(0, 1)) {
          const previous = this.index.albums.filter((album) => album._root === root)
          try {
            const stat = await fs.stat(root)
            if (!stat.isDirectory()) throw new Error('根目录不是文件夹')
            // Finish enumeration before replacing anything. What could not be read this time is
            // counted and never taken for a deletion: a known song keeps its record (readAlbum), the
            // albums of a folder that could not be listed stay, offline.
            const skipped = { encrypted: 0, unreadable: 0, folders: [] }
            const folders = await walkAlbums(root, skipped)
            const rootAlbums = []
            const previousById = new Map(previous.map((album) => [album.id, album]))
            for (const folder of folders) {
              const album = await this.readAlbum(root, folder, previousById.get(albumEntryId(folder)), skipped)
              if (album) rootAlbums.push(album)
            }
            const found = new Set(rootAlbums.map((album) => album.id))
            rootAlbums.push(...previous.filter((album) => !found.has(album.id) && skipped.folders.some((folder) => insidePath(folder, album.folder))).map((album) => ({ ...album, offline: true })))
            nextAlbums.push(...rootAlbums)
            nextRoots.push({ path: root, status: 'online', ...(skipped.encrypted ? { encrypted: skipped.encrypted } : {}), ...(skipped.unreadable ? { unreadable: skipped.unreadable } : {}) })
          } catch (error) {
            nextRoots.push({ path: root, status: 'offline', error: error.message })
            nextAlbums.push(...previous.map((album) => ({ ...album, offline: true })))
          }
        }
        // A concurrent online request may have updated the prior objects.
        for (const album of nextAlbums) {
          const current = this.index.albums.find((entry) => entry.id === album.id)
          if (current?.online?.checkedAt && (!album.online?.checkedAt || current.online.checkedAt > album.online.checkedAt)) {
            album.online = current.online
            album._onlineGenres = current._onlineGenres
            album.description = current.description
            album.descriptionSource = current.descriptionSource
            album.producers = uniqueProducers([...(album.producers ?? []).filter((person) => person.source !== 'MusicBrainz'), ...current.producers.filter((person) => person.source === 'MusicBrainz')])
          }
          if (current?.introduction?.checkedAt && current.title === album.title && current.artist === album.artist && current.year === album.year && (!album.introduction?.checkedAt || current.introduction.checkedAt > album.introduction.checkedAt)) {
            album.introduction = current.introduction
            album.description = current.description
            album.descriptionSource = current.descriptionSource
          }
        }
        // Without a main folder (none chosen yet, or config.json set aside at a start) the index stays
        // as it is, unshown (inLibrary), for that folder chosen again (as library.rs scan_sync).
        if (this.mainFolder !== undefined) {
          this.index = { version: 1, albums: nextAlbums, roots: nextRoots, scannedAt: timestamp() }
          await this.saveIndex()
        }
        this.scanStatus.finishedAt = timestamp()
      } catch (error) {
        this.scanStatus.error = error.message
      } finally {
        this.scanStatus.running = false
        this.scanPromise = null
        this.onChange()
      }
      if (this.config.onlineEnabled) void this.enrich().catch(() => {})
      return this.snapshot()
    })()
    return this.scanPromise
  }

  /** An album record from what the walk found; null when none of its songs could be taken. */
  async readAlbum(root, entry, previous, skipped = { unreadable: 0 }) {
    const id = albumEntryId(entry)
    let fileCover
    if (entry.cover) {
      try {
        const stat = await fs.stat(entry.cover)
        fileCover = { path: entry.cover, mime: imageMime(entry.cover), version: hash(`${entry.cover}:${stat.size}:${stat.mtimeMs}`), embedded: false }
      } catch (error) {
        // An image that cannot be read now keeps the cover the last scan found in it.
        if (error.code !== 'ENOENT') skipped.unreadable += 1
        if (previous?._cover && !previous._cover.embedded && previous._cover.path === entry.cover) fileCover = previous._cover
      }
    }
    // A single owns its embedded artwork; a matching image is only a fallback.
    let cover = entry.singleFile ? undefined : fileCover
    const tracks = []
    // The last scan's songs of this album, by path: one look-up per song.
    const oldTracks = new Map()
    for (const track of previous?.tracks ?? []) if (!oldTracks.has(track._path)) oldTracks.set(track._path, track)
    for (const file of entry.tracks) {
      const old = oldTracks.get(file)
      // A song that cannot be read now (in use by another program, not permitted) keeps the record
      // the last scan made (read again next time) and a new one waits for the next scan; either way
      // it is counted. One that is gone was deleted, unless its name only seems gone: a name that is
      // not valid Unicode reaches this service with U+FFFD in it, and is counted (as library.rs walk).
      const keep = (error) => {
        if (error.code === 'ENOENT' && !file.includes('\uFFFD')) return
        skipped.unreadable += 1
        if (old) {
          tracks.push(old)
          if (!cover && old._embeddedCover) cover = old._embeddedCover
        }
      }
      let stat
      try { stat = await fs.stat(file) } catch (error) { keep(error); continue }
      const fingerprint = `${stat.size}:${stat.mtimeMs}`
      if (old?._fingerprint === fingerprint && old._metadataVersion === METADATA_VERSION && (cover || old._embeddedCover !== undefined)) {
        tracks.push(old)
        if (!cover && old._embeddedCover) cover = old._embeddedCover
        continue
      }
      // A permission/sharing failure is not a missing tag.
      try { await (await fs.open(file, 'r')).close() } catch (error) { keep(error); continue }
      let metadata
      let metadataError
      try { metadata = await this.parseFile(file, { duration: true, skipCovers: !!cover }) }
      catch (error) { metadataError = error.message; metadata = { common: {}, format: {} } }
      const common = metadata.common ?? {}
      let embedded = null
      if (!cover) {
        const picture = common.picture?.find((image) => /front/i.test(image.type ?? '')) ?? common.picture?.[0]
        if (picture?.data?.length && picture.data.length < 30 * 1024 * 1024) {
          const mime = picture.format === 'image/jpg' ? 'image/jpeg' : picture.format
          const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' })[mime]
          if (extension) {
            const version = hash(picture.data)
            const target = path.join(this.dataDir, 'artwork', `${version}${extension}`)
            await fs.mkdir(path.dirname(target), { recursive: true })
            if (!(await exists(target))) await fs.writeFile(target, picture.data, { mode: 0o600 })
            embedded = { path: target, mime, version, embedded: true }
            cover = embedded
          }
        }
      }
      const extension = path.extname(file).toLowerCase()
      const trackId = `track-${hash(file)}`
      const discPrefix = path.basename(file).match(/^(\d{1,2})[-_](\d{1,3})(?:[\s._-]|$)/)
      const discNumber = numberOrUndefined(common.disk?.no) ?? (discPrefix ? numberOrUndefined(Number(discPrefix[1])) : undefined)
      const trackNumber = numberOrUndefined(common.track?.no) ?? (discPrefix ? numberOrUndefined(Number(discPrefix[2])) : undefined)
      tracks.push({
        id: trackId, albumId: id, title: text(common.title) || path.parse(file).name,
        artist: text(common.artist) || text(common.albumartist) || '未知艺术家',
        trackNumber, discNumber,
        duration: Number.isFinite(metadata.format?.duration) ? metadata.format.duration : 0,
        format: extension.slice(1).toUpperCase(), codec: metadata.format?.codec,
        bitsPerSample: numberOrUndefined(metadata.format?.bitsPerSample), sampleRate: numberOrUndefined(metadata.format?.sampleRate),
        bitrate: numberOrUndefined(metadata.format?.bitrate), numberOfChannels: numberOrUndefined(metadata.format?.numberOfChannels),
        lossless: typeof metadata.format?.lossless === 'boolean' ? metadata.format.lossless : undefined,
        browserPlayable: BROWSER_EXTENSIONS.has(extension), audioUrl: `/api/audio/${trackId}`,
        relativePath: path.relative(root, file),
        _path: file, _fingerprint: fingerprint, _metadataVersion: METADATA_VERSION,
        _common: {
          album: text(common.album), albumartist: text(common.albumartist), year: numberOrUndefined(common.year),
          genres: unique((common.genre ?? []).map(text)), producers: unique((common.producer ?? []).map(text)),
          releaseId: firstString(common.musicbrainz_albumid), releaseGroupId: firstString(common.musicbrainz_releasegroupid),
          discTotal: numberOrUndefined(common.disk?.of), discNumberSource: common.disk?.no ? 'tag' : discPrefix ? 'filename' : undefined,
          comments: (common.comment ?? []).map((comment) => typeof comment === 'string' ? comment : text(comment.text)).filter(Boolean),
          ...(metadataError ? { metadataError } : {}),
        },
        _embeddedCover: cover && !embedded ? undefined : embedded,
      })
    }
    cover ??= fileCover
    if (!tracks.length) return null
    tracks.sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999) || a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true }))
    const first = tracks[0]
    const localGenres = unique(tracks.flatMap((track) => track._common.genres))
    const releaseId = tracks.map((track) => track._common.releaseId).find((value) => MBID.test(value))
    const releaseGroupId = tracks.map((track) => track._common.releaseGroupId).find((value) => MBID.test(value))
    const title = entry.singleFile ? first?.title || path.parse(entry.singleFile).name : first?._common.album || path.basename(entry.folder)
    const artist = (entry.singleFile ? first?.artist : first?._common.albumartist || first?.artist) || '未知艺术家'
    const unchangedIdentity = previous && title === previous.title && artist === previous.artist && first?._common.year === previous.year && tracks.length === previous.tracks.length && (!releaseId || releaseId === previous.online?.releaseId)
    return {
      id, title, artist, year: first?._common.year,
      discCount: Math.max(1, ...tracks.map((track) => track._common.discTotal ?? track.discNumber ?? 1)),
      localNote: unique(tracks.flatMap((track) => track._common.comments ?? [])).join('\n') || undefined,
      description: unchangedIdentity && previous.descriptionSource?.url ? previous.description : undefined,
      descriptionSource: unchangedIdentity && previous.descriptionSource?.url ? previous.descriptionSource : undefined,
      introduction: unchangedIdentity ? previous.introduction : undefined,
      genreId: 'unclassified', rawGenres: localGenres,
      folder: entry.folder, tracks, offline: false,
      producers: uniqueProducers([
        ...tracks.flatMap((track) => track._common.producers.map((name) => ({ name, role: 'producer', source: 'local', trackTitle: track.title }))),
        ...(unchangedIdentity ? (previous.producers ?? []).filter((person) => person.source !== 'local') : []),
      ]),
      online: unchangedIdentity ? previous.online : { status: 'unqueried', releaseId, releaseGroupId },
      _root: root, _cover: cover, _localGenres: localGenres,
      _onlineGenres: unchangedIdentity ? previous._onlineGenres ?? [] : [],
    }
  }

  trackFile(id) {
    for (const album of this.index.albums) if (this.inLibrary(album)) {
      const track = album.tracks.find((entry) => entry.id === id)
      if (track) return { path: track._path, mime: audioMime(track._path), allowedRoot: album._root }
    }
    return null
  }

  artworkFile(id) {
    const album = this.index.albums.find((entry) => entry.id === id && this.inLibrary(entry))
    return album?._cover ? { ...album._cover, allowedRoot: album._cover.embedded ? this.dataDir : album._root } : null
  }

  // A song's lyrics (the owner, 2026-10-17), only read: a same-named .lrc beside it inside its folder,
  // else the lyrics of its tags (synchronised ones timed in milliseconds as LRC lines). Their bytes,
  // which the page decodes; null when it has none, undefined for a song not in the index.
  async lyrics(id) {
    const file = this.trackFile(id)
    if (!file) return undefined
    const [song, root] = await Promise.all([fs.realpath(file.path), fs.realpath(file.allowedRoot)])
    const inside = (target) => {
      const relative = path.relative(root, target)
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    }
    if (!inside(song)) throw Object.assign(new Error('文件已移出配置的音乐目录'), { status: 403 })
    try {
      const sidecar = await fs.realpath(path.join(path.dirname(song), `${path.parse(song).name}.lrc`))
      const stat = await fs.stat(sidecar)
      if (inside(sidecar) && stat.isFile() && stat.size > 0 && stat.size <= MAX_LYRICS_BYTES) return await fs.readFile(sidecar)
    } catch {}
    if (/\.(?:dsf|dff)$/i.test(song)) return null
    try {
      // The tags as written (`native`): the library's own reading of lyrics text keeps only some of
      // its lines and drops [offset:] and the like. Synchronised ID3v2 lyrics timed in milliseconds
      // first, else the first lyrics text; over the .lrc's limit, none.
      const { native } = await this.parseFile(song, { duration: false, skipCovers: true })
      const tags = Object.values(native ?? {}).flat()
      const timed = tags.find((tag) => tag?.id === 'SYLT' && tag.value?.timeStampFormat === 2 && [0, 1].includes(tag.value.contentType) && tag.value.syncText?.length)
      const text = timed
        ? syncedLrc(timed.value.syncText)
        : tags.map((tag) => (LYRIC_TAGS.has(String(tag?.id).toUpperCase()) ? (typeof tag.value === 'string' ? tag.value : tag.value?.text) : undefined)).find((value) => typeof value === 'string' && value.trim())
      return text && Buffer.byteLength(text) <= MAX_LYRICS_BYTES ? Buffer.from(text, 'utf8') : null
    } catch {
      return null
    }
  }

  async musicBrainz(endpoint, params = {}) {
    const url = new URL(`https://musicbrainz.org/ws/2/${endpoint}`)
    for (const [key, value] of Object.entries({ ...params, fmt: 'json' })) url.searchParams.set(key, value)
    return this.onlineJson(url)
  }

  async onlineJson(url) {
    if (!this.musicBrainzContact) throw new Error('请先配置自己的联系邮箱或项目网址，以满足 MusicBrainz User-Agent 要求')
    const wait = Math.max(0, this.lastMusicBrainzRequest + 1100 - Date.now())
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    this.lastMusicBrainzRequest = Date.now()
    const response = await this.fetcher(url, {
      headers: { 'User-Agent': `RhineLocalMusic/0.1 (${this.musicBrainzContact})`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000), redirect: 'error',
    })
    if (!response.ok) throw new Error(`${url.hostname} HTTP ${response.status}，保留本地资料，可稍后重试`)
    return response.json()
  }

  async albumIntroduction(group) {
    // Only follow links already attached to the confidently matched album group;
    // title-only encyclopedia searches can silently pick an unrelated work.
    const relations = group?.relations ?? []
    let language
    let title
    const wikidata = relations.find((relation) => relation.type === 'wikidata')?.url?.resource
    const qid = wikidata?.match(/^https?:\/\/(?:www\.)?wikidata\.org\/wiki\/(Q\d+)\/?$/)?.[1]
    if (qid) {
      const entity = await this.onlineJson(new URL(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`))
      const links = entity.entities?.[qid]?.sitelinks
      if (links?.zhwiki?.title) { language = 'zh'; title = links.zhwiki.title }
      else if (links?.enwiki?.title) { language = 'en'; title = links.enwiki.title }
    }
    if (!title) {
      const candidates = relations.map((relation) => relation.url?.resource).filter(Boolean).map((resource) => {
        try {
          const url = new URL(resource)
          const match = /^(zh|en)\.wikipedia\.org$/.exec(url.hostname)
          return match && url.pathname.startsWith('/wiki/') ? { language: match[1], title: decodeURIComponent(url.pathname.slice(6)).replaceAll('_', ' ') } : null
        } catch { return null }
      }).filter(Boolean).sort((a, b) => (a.language === 'zh' ? -1 : 1) - (b.language === 'zh' ? -1 : 1))
      if (candidates[0]) ({ language, title } = candidates[0])
    }
    if (!title) return null
    const api = new URL(`https://${language}.wikipedia.org/w/api.php`)
    const params = { action: 'query', format: 'json', formatversion: '2', prop: 'extracts|info|pageprops', inprop: 'url', ppprop: 'disambiguation', exintro: '1', explaintext: '1', exchars: '800', redirects: '1', titles: title }
    for (const [key, value] of Object.entries(params)) api.searchParams.set(key, value)
    const data = await this.onlineJson(api)
    const page = data.query?.pages?.find((entry) => !entry.missing && !Object.hasOwn(entry.pageprops ?? {}, 'disambiguation') && text(entry.extract))
    if (!page) return null
    return {
      description: text(page.extract),
      descriptionSource: { name: language === 'zh' ? '维基百科' : 'Wikipedia', url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`, checkedAt: timestamp(), license: 'CC BY-SA（以来源页为准）' },
    }
  }

  async enrich({ albumIds, force = false } = {}) {
    if (this.enrichPromise) return this.enrichPromise
    if (albumIds !== undefined && (!Array.isArray(albumIds) || albumIds.some((id) => typeof id !== 'string'))) throw new Error('albumIds 必须是专辑 ID 数组')
    const selected = this.index.albums.filter((album) => !album.offline && this.inLibrary(album) && (!albumIds || albumIds.includes(album.id)) && (force || !album.online?.checkedAt))
    this.enrichStatus = { running: true, completed: 0, total: selected.length }
    this.enrichPromise = (async () => {
      // Yield once even for an empty queue so finally clears the assigned promise.
      await Promise.resolve()
      try {
        for (const album of selected) {
          await this.enrichAlbum(album)
          this.enrichStatus.completed += 1
          await this.saveIndex()
          this.onChange()
        }
      } catch (error) { this.enrichStatus.error = error.message }
      finally { this.enrichStatus.running = false; this.enrichPromise = null }
      return this.snapshot()
    })()
    return this.enrichPromise
  }

  async updateIntroductions({ albumIds, force = false } = {}) {
    if (this.introductionsPromise) return this.introductionsPromise
    if (albumIds !== undefined && (!Array.isArray(albumIds) || albumIds.length > 10000 || albumIds.some((id) => typeof id !== 'string'))) throw new Error('albumIds 必须是专辑 ID 数组')
    if (typeof force !== 'boolean') throw new Error('force 必须为布尔值')
    const selected = this.index.albums.filter((album) => {
      if (!this.inLibrary(album) || (albumIds && !albumIds.includes(album.id))) return false
      if (force) return true
      if (album.description && album.descriptionSource?.url) return false
      const cached = album.introduction
      return !cached || cached.status === 'error' || !cached.checkedAt || Date.now() - Date.parse(cached.checkedAt) > 7 * 86400_000
    }).map((album) => ({ id: album.id, title: album.title, artist: album.artist, year: album.year }))
    this.introductionsStatus = { running: true, completed: 0, total: selected.length, updated: 0, notFound: 0, failed: 0 }
    this.introductionsPromise = (async () => {
      await Promise.resolve()
      let consecutiveFailures = 0
      try {
        for (const album of selected) {
          this.introductionsStatus.currentAlbum = album.title
          this.onChange()
          let result
          try { result = await this.introductionProvider.lookup(album) }
          catch (error) { result = { status: 'error', checkedAt: timestamp(), error: error.message } }
          if (!['matched', 'not-found', 'uncertain', 'error'].includes(result?.status)) result = { status: 'error', checkedAt: timestamp(), error: '专辑介绍来源返回无效状态' }
          const current = this.index.albums.find((entry) => entry.id === album.id)
          if (current && current.title === album.title && current.artist === album.artist && current.year === album.year) {
            current.introduction = { status: result.status, checkedAt: result.checkedAt ?? timestamp(), ...(result.error ? { error: result.error } : {}), ...(result.candidateUrl ? { candidateUrl: result.candidateUrl } : {}) }
            if (result.status === 'matched' && result.description && result.descriptionSource?.url) {
              current.description = result.description
              current.descriptionSource = result.descriptionSource
              this.introductionsStatus.updated += 1
            } else if (result.status === 'error' || result.status === 'matched') {
              current.introduction.status = 'error'
              current.introduction.error ||= '来源未提供可引用的专辑介绍'
              this.introductionsStatus.failed += 1
            } else this.introductionsStatus.notFound += 1
          }
          this.introductionsStatus.completed += 1
          if (result.status === 'error') {
            consecutiveFailures += 1
            this.introductionsStatus.error = result.error
          } else consecutiveFailures = 0
          await this.saveIndex()
          this.onChange()
          if (consecutiveFailures >= 3 && this.introductionsStatus.completed < selected.length) {
            this.introductionsStatus.error = `百科来源连续 3 次访问失败，已暂停剩余 ${selected.length - this.introductionsStatus.completed} 张，避免重复超时。${result.error ?? ''}`
            break
          }
        }
      } catch (error) { this.introductionsStatus.error = `更新未完成：${error.message}` }
      finally {
        this.introductionsStatus.running = false
        delete this.introductionsStatus.currentAlbum
        this.introductionsPromise = null
        this.onChange()
      }
      return this.snapshot()
    })()
    return this.introductionsPromise
  }

  async enrichAlbum(album) {
    const checkedAt = timestamp()
    try {
      let releaseId = album.online?.releaseId
      if (!releaseId) {
        const escape = (value) => value.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&')
        const found = await this.musicBrainz('release', { query: `release:"${escape(album.title)}" AND artist:"${escape(album.artist)}"`, limit: '5' })
        const candidates = (found.releases ?? []).filter((candidate) =>
          normalized(candidate.title) === normalized(album.title) &&
          normalized((candidate['artist-credit'] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? '').join('')) === normalized(album.artist) &&
          Number(candidate['track-count']) === album.tracks.length &&
          (!album.year || !candidate.date || candidate.date.startsWith(String(album.year))) && Number(candidate.score ?? 0) >= 95)
        // Multiple pressings are not interchangeable for production credits.
        if (candidates.length !== 1) {
          album.online = { ...album.online, status: found.releases?.length ? 'uncertain' : 'not-found', checkedAt }
          return
        }
        releaseId = candidates[0].id
      }
      if (!MBID.test(releaseId)) throw new Error('无效的 MusicBrainz Release ID')
      const release = await this.musicBrainz(`release/${releaseId}`, { inc: 'artist-credits+recordings+recording-level-rels+artist-rels+release-groups+genres' })
      const releaseGroupId = release['release-group']?.id ?? album.online?.releaseGroupId
      const group = releaseGroupId && MBID.test(releaseGroupId) ? await this.musicBrainz(`release-group/${releaseGroupId}`, { inc: 'genres+artist-rels+url-rels' }) : null
      const genres = [...(release.genres ?? []), ...(group?.genres ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).map((genre) => text(genre.name))
      const producers = []
      const collect = (relations = [], trackTitle) => {
        for (const relation of relations) if (/producer/i.test(relation.type ?? '') && relation.artist?.name) {
          producers.push({ name: relation.artist.name, role: relation.type, source: 'MusicBrainz', trackTitle, url: `https://musicbrainz.org/artist/${relation.artist.id}` })
        }
      }
      collect(release.relations)
      collect(group?.relations)
      for (const medium of release.media ?? []) for (const track of medium.tracks ?? []) collect(track.recording?.relations, track.title ?? track.recording?.title)
      const online = { status: 'matched', releaseId, releaseGroupId, checkedAt, sourceUrl: `https://musicbrainz.org/release/${releaseId}` }
      let introduction
      try {
        introduction = await this.albumIntroduction(group)
        online.descriptionStatus = introduction ? 'available' : 'not-found'
      } catch (error) {
        online.descriptionStatus = 'error'
        online.descriptionError = error.message
      }
      // Commit after all awaited requests, to the current record after any scan.
      const current = this.index.albums.find((entry) => entry.id === album.id)
      if (!current || current.title !== album.title || current.artist !== album.artist || current.year !== album.year) return
      current._onlineGenres = unique(genres)
      current.producers = uniqueProducers([...(current.producers ?? []).filter((person) => person.source !== 'MusicBrainz'), ...producers])
      current.online = online
      if (introduction) Object.assign(current, introduction)
      Object.assign(album, { _onlineGenres: current._onlineGenres, producers: current.producers, online: current.online, description: current.description, descriptionSource: current.descriptionSource })
    } catch (error) {
      album.online = { ...album.online, status: 'error', checkedAt, error: error.message }
      this.enrichStatus.error = error.message
    }
  }
}

function uniqueProducers(producers) {
  const seen = new Set()
  return producers.filter((producer) => {
    const key = `${producer.name}:${producer.role}:${producer.trackTitle ?? ''}:${producer.source}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
