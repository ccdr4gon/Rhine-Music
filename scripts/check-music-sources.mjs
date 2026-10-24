// One app, one current source (the owner, 2026-10-06: "let's delete the concept of skin mode or
// local music mode, now we only have the different concept"): 本地音乐 or a player. These checks
// cover the switch between them, what a switch hands to the page it loads, what is remembered for
// the next start, and the app's wiring. The players here are made up (fake ports, fictional titles).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ExternalMediaConnection, mediaSourcesMarkup, readSourceLink,
} from '../src/external_player/external-media.ts';
import {
  PLAYER_MODULES, pageSource, sourceAddress, markSourceSwitch, takeSourceSwitch, playerLinks, playerMediaPort,
} from '../src/music-sources.ts';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const app = read('src/music-app.ts');
const body = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, end);
  return text.slice(from, to);
};

const caps = { toggle: true, previous: true, next: true, stop: false, seek: false };
const session = (id, extra = {}) => ({ id, name: `Player ${id}`, kind: 'smtc', title: 'Fictional Song', artist: 'Fictional Artist', album: '', playback: 'paused', capabilities: caps, ...extra });
const netease = (id) => session(id, { name: 'cloudmusic.exe', player: 'netease', app: 'cloudmusic.exe' });
const qq = (id) => session(id, { name: 'QQMusic.exe', player: 'qqmusic', app: 'QQMusic.exe' });
const third = (id) => session(id, { name: 'Fictional Player', app: 'Fictional.Player_0abc!App' });
const anonymous = (id) => session(id, { name: 'Fictional Anonymous' });

/**
 * The app's connection, as music-app.ts builds both of its uses (the player as the current source,
 * and the chooser while 本地音乐 is current): the registry's port and links, the preferences as they
 * would be saved. `saved` is what the preferences hold before, `told` what they are told after.
 */
function connection(saved, sources) {
  let list = sources;
  const told = [];
  const calls = [];
  const port = playerMediaPort({
    async snapshot() { if (list instanceof Error) throw list; return { sources: list }; },
    async control(...args) { calls.push(args); },
  });
  const media = new ExternalMediaConnection(port, playerLinks(saved === undefined ? undefined : JSON.parse(JSON.stringify(saved)), (link) => told.push(link)));
  return { media, told, calls, set: (next) => { list = next; } };
}
// A start of the client, as main.rs decides it (opens_player; its Rust unit tests are the reference).
const remembers = (link) => !!link && typeof link === 'object' && !Array.isArray(link) && (typeof link.player === 'string'
  ? PLAYER_MODULES.some((player) => player.id === link.player)
  : typeof link.app === 'string' && link.app.length > 0 && link.app.length <= 512);
const opensPlayer = (prefs) => {
  if (!prefs || typeof prefs !== 'object') return false;
  const player = 'source' in prefs ? prefs.source === 'player' : prefs.playerMode === 'external';
  return player && remembers(prefs.playerLink);
};

test('the page shows the source its address names: a player for ?source=player (and the old ?mode=external), else 本地音乐', () => {
  assert.equal(pageSource(''), 'local');
  assert.equal(pageSource('?source=player'), 'player');
  assert.equal(pageSource('?scene=archive&source=player'), 'player');
  assert.equal(pageSource('?mode=external'), 'player', 'an address an earlier build opened still works');
  assert.equal(pageSource('?mode=external&scene=archive'), 'player');
  for (const search of ['?source=local', '?source=PLAYER', '?source=', '?mode=local', '?mode=EXTERNAL', '?player=1', '?original=1'])
    assert.equal(pageSource(search), 'local', search);
});

test('switching keeps every other parameter of the address, drops the old mode and any fragment', () => {
  const base = 'http://127.0.0.1:5177/';
  assert.equal(sourceAddress(base, 'player'), `${base}?source=player`);
  assert.equal(sourceAddress(`${base}?source=player`, 'local'), base);
  assert.equal(sourceAddress(`${base}?mode=external`, 'local'), base);
  assert.equal(sourceAddress(`${base}?mode=external&nav=previous`, 'player'), `${base}?nav=previous&source=player`);
  assert.equal(sourceAddress(`${base}?scene=archive#x`, 'player'), `${base}?scene=archive&source=player`);
  assert.equal(sourceAddress(`${base}?lighting=baseline&source=player`, 'local'), `${base}?lighting=baseline`);
  for (const next of ['local', 'player'])
    assert.equal(pageSource(new URL(sourceAddress(`${base}?mode=external&scene=archive`, next)).search), next);
});

test('a switch hands the next page what it needs once: no opening, the panel again, the session picked', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  markSourceSwitch(storage, { to: 'player', panel: true, session: 'smtc-0001' });
  assert.deepEqual(takeSourceSwitch(storage, 'player'), { to: 'player', panel: true, session: 'smtc-0001' });
  assert.equal(takeSourceSwitch(storage, 'player'), undefined, 'read once: a reload afterwards is an ordinary start');
  markSourceSwitch(storage, { to: 'local', panel: false });
  assert.deepEqual(takeSourceSwitch(storage, 'local'), { to: 'local', panel: false });
  // One meant for the other source counts as none (and is dropped all the same).
  markSourceSwitch(storage, { to: 'player', panel: true });
  assert.equal(takeSourceSwitch(storage, 'local'), undefined);
  assert.equal(store.size, 0);
  // Whatever else is stored there is no switch.
  for (const raw of ['', 'null', '[]', '"player"', '{"to":"player","panel":"yes","session":7}', '{broken'])
  {
    store.set('rhine-source-switch', raw);
    const taken = takeSourceSwitch(storage, 'player');
    assert.ok(taken === undefined || (taken.panel === false && !('session' in taken)), raw);
  }
  store.set('rhine-source-switch', JSON.stringify({ to: 'player', panel: true, session: 'x'.repeat(201) }));
  assert.deepEqual(takeSourceSwitch(storage, 'player'), { to: 'player', panel: true }, 'an overlong session is not one');
  // No storage, or one that refuses: no switch, nothing thrown.
  const refusing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  markSourceSwitch(refusing, { to: 'player', panel: true });
  assert.equal(takeSourceSwitch(refusing, 'player'), undefined);
  assert.equal(takeSourceSwitch(undefined, 'player'), undefined);
});

test('opening 播放器 while no player was ever chosen: NetEase is the default link, QQ Music never connects by itself', async () => {
  // NetEase running: connected at the first reading, and remembered (the app then switches to it).
  const both = connection(undefined, [qq('q1'), netease('n1'), third('x1')]);
  await both.media.refresh();
  assert.equal(both.media.selected?.id, 'n1');
  assert.deepEqual(both.told, [{ player: 'netease' }]);
  assert.equal(both.media.allowGlobalMediaKeys, false);
  // Only QQ Music and another player: nothing is connected by itself; NetEase is still awaited.
  const without = connection(undefined, [qq('q1'), third('x1')]);
  await without.media.refresh();
  assert.equal(without.media.selected, undefined);
  assert.equal(without.media.awaitsPreferred, true);
  assert.deepEqual(without.told, []);
  assert.doesNotMatch(mediaSourcesMarkup(without.media), /默认/);
  // The user picks QQ Music: it is remembered by its module.
  assert.equal(without.media.select('q1'), true);
  assert.deepEqual(without.told, [{ player: 'qqmusic' }]);
  assert.deepEqual([...both.calls, ...without.calls], [], 'choosing a source sends nothing to any player');
});

test('opening 播放器 with a player remembered: that player, and no other; after a disconnect, none', async () => {
  const remembered = connection({ player: 'qqmusic' }, [netease('n1'), third('x1')]);
  await remembered.media.refresh();
  assert.equal(remembered.media.selected, undefined, 'NetEase is not taken in its place');
  assert.equal(remembered.media.remembers, true);
  assert.equal(remembered.media.preferred?.name, 'QQ音乐');
  remembered.set([netease('n1'), qq('q2'), third('x1')]);
  await remembered.media.refresh();
  assert.equal(remembered.media.selected?.id, 'q2');
  assert.deepEqual(remembered.told, [], 'the same player: nothing new to save');
  // 断开连接 forgets it (also with 本地音乐 current, before it was found): nothing connects by itself.
  const forgotten = connection({ player: 'qqmusic' }, [netease('n1')]);
  await forgotten.media.refresh();
  forgotten.media.disconnect();
  assert.deepEqual(forgotten.told, [null]);
  forgotten.set([netease('n2'), qq('q3')]);
  await forgotten.media.refresh();
  assert.equal(forgotten.media.selected, undefined);
  const after = connection(null, [netease('n1'), qq('q1')]);
  await after.media.refresh();
  assert.equal(after.media.selected, undefined, 'a disconnect saved earlier holds: not even NetEase');
  assert.doesNotMatch(mediaSourcesMarkup(after.media), /默认/);
});

test('the session picked before the switch is connected on the page that shows the player, also where the link cannot tell', async () => {
  // Two sessions of one player: remembered by its app id, which matches both.
  const chooser = connection(undefined, [third('x1'), third('x2'), qq('q1')]);
  await chooser.media.refresh();
  chooser.media.select('x2');
  assert.deepEqual(chooser.told, [{ app: 'Fictional.Player_0abc!App', name: 'Fictional Player' }]);
  const page = connection(chooser.told.at(-1), [third('x1'), third('x2'), qq('q1')]);
  await page.media.refresh();
  assert.equal(page.media.selected, undefined, 'the link alone never guesses between two sessions');
  assert.equal(page.media.ambiguous, true);
  assert.equal(page.media.select('x2'), true, 'the handed-over session');
  assert.equal(page.media.selected?.id, 'x2');
  assert.deepEqual(page.told, [], 'the same link: nothing new to save');
  // A player without an app id cannot be remembered: the hand-over is what connects it.
  const plain = connection(undefined, [anonymous('a1'), qq('q1')]);
  await plain.media.refresh();
  plain.media.select('a1');
  assert.deepEqual(plain.told, [null]);
  const shown = connection(null, [anonymous('a1'), qq('q1')]);
  await shown.media.refresh();
  assert.equal(shown.media.selected, undefined);
  assert.equal(shown.media.select('a1'), true);
  assert.equal(shown.media.allowGlobalMediaKeys, false, 'a new connection, without the global media keys');
});

test('the session picked before the switch waits for a snapshot that was read: a failed first read does not lose it', async () => {
  // As refreshExternal takes it: only after a read (externalMedia.unread false), once.
  const take = (media, handed) => {
    if (!handed || media.unread) return handed;
    if (media.selected?.id !== handed) media.select(handed);
    return undefined;
  };
  const page = connection({ app: 'Fictional.Player_0abc!App', name: 'Fictional Player' }, new Error('读取媒体来源超时'));
  let handed = 'x2';
  await page.media.refresh();
  assert.equal(page.media.unread, true);
  handed = take(page.media, handed);
  assert.equal(handed, 'x2', 'kept: the failed read said nothing of the session');
  page.set(new Error('媒体读取请求已过期'));
  await page.media.refresh();
  handed = take(page.media, handed);
  page.set([third('x1'), third('x2'), qq('q1')]);
  await page.media.refresh();
  handed = take(page.media, handed);
  assert.equal(handed, undefined);
  assert.equal(page.media.selected?.id, 'x2', 'connected at the first good read, although the link cannot tell the two apart');
  // A good read without the session drops the pick: it is not connected when it turns up later.
  const gone = connection(null, [qq('q1')]);
  await gone.media.refresh();
  assert.equal(take(gone.media, 'a1'), undefined);
  gone.set([anonymous('a1'), qq('q1')]);
  await gone.media.refresh();
  assert.equal(gone.media.selected, undefined);
});

test('the next start opens what was chosen last: 本地音乐 first of all, a player only while it is remembered', () => {
  // As the page saves the preferences on each path (music-app.ts), read the way main.rs reads them.
  const first = undefined;
  assert.equal(opensPlayer(first), false, 'the first start ever: 本地音乐');
  assert.equal(opensPlayer({ source: 'local' }), false);
  for (const link of [{ player: 'netease' }, { player: 'qqmusic' }, { app: 'Fictional.Player_0abc!App', name: 'Fictional Player' }]) {
    assert.equal(opensPlayer({ source: 'player', playerLink: link }), true, JSON.stringify(link));
    assert.equal(opensPlayer({ source: 'local', playerLink: link }), false, '本地音乐 chosen last keeps the player for 播放器 only');
    assert.deepEqual(readSourceLink(link, PLAYER_MODULES)?.player ?? readSourceLink(link, PLAYER_MODULES)?.app, link.player ?? link.app);
  }
  assert.equal(opensPlayer({ source: 'player', playerLink: null }), false, 'after 断开连接: 本地音乐');
  assert.equal(opensPlayer({ source: 'player' }), false);
  // Preferences of a build with modes, until the page saves the source in their place.
  assert.equal(opensPlayer({ playerMode: 'external', playerLink: { player: 'netease' } }), true);
  assert.equal(opensPlayer({ playerMode: 'local', playerLink: { player: 'netease' } }), false);
  assert.equal(opensPlayer({ source: 'local', playerMode: 'external', playerLink: { player: 'netease' } }), false);
  // The mirror above is main.rs's own rule.
  const main = read('src-tauri/src/main.rs');
  assert.match(main, /Some\(source\) => source\.as_str\(\) == Some\("player"\),/);
  assert.match(main, /None => preferences\.get\("playerMode"\)\.and_then\(serde_json::Value::as_str\) == Some\("external"\),/);
});

test('the app: one page per source, local playback and BGM only for 本地音乐, a switch reloads without the opening', () => {
  // The page's source is its address; nothing else decides it.
  assert.match(app, /const currentSource: SourceKind = pageSource\(location\.search\);\nconst playerCurrent = currentSource === "player";/);
  assert.equal(app.match(/pageSource\(/g).length, 1);
  assert.doesNotMatch(app, /searchParams\.set\("mode"|mode=external|"external-mode"|"local-mode"|changePlayerMode/);
  // The local player (its audio and the BGM) and the interface sounds exist only for 本地音乐.
  assert.match(app, /const player = playerCurrent \? undefined : new MusicPlayer\(\{/);
  assert.match(app, /sound: !playerCurrent && preferences\.sound,/);
  // The players' connection for a player as the current source; the chooser for 本地音乐, in the client only.
  assert.match(app, /const externalMedia = playerCurrent\n  \? new ExternalMediaConnection\(playerMediaPort\(nativeMediaPort\), playerLinks\(preferences\.playerLink, rememberPlayer\)\)\n  : undefined;/);
  assert.match(app, /const playerChooser = !playerCurrent && isDesktop\n  \? new ExternalMediaConnection\(playerMediaPort\(nativeMediaPort\), playerLinks\(preferences\.playerLink, rememberPlayer\)\)\n  : undefined;/);
  // The switch: the local player stops first, the choice is saved and written out, then the page goes,
  // replaced in the page's history: no back or forward (a mouse button, Alt+←) leads to the other
  // source's page (the review of 2026-10-23; check-scene-switching.mjs has the guards).
  const change = body(app, 'function switchSource(', '\n}\n');
  assert.match(change, /if \(next === currentSource \|\| sourceSwitching\) return;/);
  const order = ['player?.stop();', 'player?.dispose();', 'preferences.source = next;', 'savePrefs();', 'markSourceSwitch(sessionStore, { to: next, panel: !!after.panel', 'flushDesktopPreferences()', 'location.replace(sourceAddress(location.href, next))'];
  assert.doesNotMatch(change, /location\.assign/);
  order.reduce((at, step) => { const next = change.indexOf(step, at); assert.ok(next > at, step); return next; }, -1);
  // The page a switch loaded: no opening animation, the header kept in view, the panel again, the session picked.
  assert.match(app, /const sourceSwitch = takeSourceSwitch\(sessionStore, currentSource\);/);
  assert.match(app, /if \(albums\.length && new URLSearchParams\(location\.search\)\.get\("scene"\) !== "archive" && !sourceSwitch\) \{\n\s*boot\?\.start\(performance\.now\(\) \/ 1000\);/);
  assert.match(app, /if \(sourceSwitch\) stage\.dataset\.switching = "true";/);
  assert.match(read('src/music.css'), /\.music-app\[data-switching="true"\] #music-loading \{\s*z-index: 5;\s*\}/);
  assert.match(app, /if \(sourceSwitch\?\.panel && playerCurrent\) openPanel\("sources", true\);\nvoid start\(\);/);
  assert.match(app, /let handedSession = sourceSwitch\?\.session;/);
  // Taken by the first snapshot that was read (one that failed says nothing of the session).
  assert.match(body(app, 'async function refreshExternal() {', '\n}\n'), /await externalMedia\.refresh\(\);[\s\S]*if \(handedSession && !externalMedia\.unread\) \{\s*const picked = handedSession;\s*handedSession = undefined;\s*if \(externalMedia\.selected\?\.id !== picked\) externalMedia\.select\(picked\);\s*\}[\s\S]*await netease\.refresh\(\);/);
  // The players are read for the chooser only while the 播放器 panel is open; a player connected there switches.
  const chooser = body(app, 'async function refreshChooser() {', '\n}\n');
  assert.match(chooser, /if \(!playerChooser \|\| panel !== "sources" \|\| panelClosing \|\| sourceSwitching\) return;/);
  assert.match(chooser, /if \(connected\) \{\s*choosePlayer\(connected\.id\);/);
  assert.match(body(app, 'function choosePlayer(', '\n}\n'), /switchSource\("player", \{ panel: true, session: id \}\);/);
  assert.match(body(app, 'function closePanel(', '\n}\n'), /clearTimeout\(chooserPoll\);/);
  assert.match(app, /if \(target\.dataset\.mediaSource && playerChooser\) \{\n\s*if \(playerChooser\.select\(target\.dataset\.mediaSource\)\) choosePlayer\(target\.dataset\.mediaSource\);/);
  assert.match(app, /case "local-source":\n\s*switchSource\("local"\);/);
});

test('the header row names both sources, the current one marked, and 本地音乐\'s own items only while it is current', () => {
  const markup = body(app, 'function sourceButtons() {', '\n}\n');
  assert.match(markup, /const players = isDesktop \|\| playerCurrent/, 'no 播放器 in a browser, where none can be connected');
  assert.match(markup, /<button data-action="sources" class="topnav-source" aria-pressed="\$\{playerCurrent\}"/);
  assert.match(markup, />播放器<span class="topnav-menu-only">来源<\/span><em class="topnav-menu-value" id="topnav-source"><\/em><\/button>/);
  // The menu form's value: 网易云音乐 for either way NetEase is connected (2026-10-06, was NETEASE),
  // never the window fallback's longer name; any other player as its module shows it.
  assert.match(app, /setText\(name, !playerCurrent \? "选择" : source \? \(isNeteaseSource\(source\) \? NETEASE_NAME : source\.name\) : "未连接"\);/);
  assert.doesNotMatch(app, /"NETEASE"/);
  assert.match(markup, /<button data-action="local-source" class="topnav-source" aria-pressed="\$\{!playerCurrent\}"/);
  assert.match(markup, /const tools = playerCurrent \? ""\n\s*: '<button data-action="library" aria-label="音乐库">音乐库<\/button><button data-action="search" aria-label="搜索">搜索/);
  assert.match(markup, /return players \+ local \+ tools;/);
  assert.match(app, /<div class="topnav-modes" id="topnav-modes">\n\s*\$\{sourceButtons\(\)\}\n\s*<div class="topnav-theme">/, 'Claude Design\'s order: 播放器 · 本地音乐 · theme · 设置');
  const css = read('src/music-chrome.css');
  assert.match(css, /\.music-app \.music-topnav \.topnav-source \{\s*color: var\(--muted\);\s*font-weight: 400;\s*\}\s*\.music-app \.music-topnav \.topnav-source\[aria-pressed="true"\] \{\s*color: var\(--ink\);\s*font-weight: 600;\s*\}/);
  // The theme words are marked the same way.
  assert.match(read('src/music-theme-switch.css'), /\.music-app \.theme-switch button\[data-theme\]\[aria-pressed="true"\] \{\s*color: var\(--ink\);\s*font-weight: 600;/);
  // No mode in what the window says.
  const shown = app.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(shown, /皮肤|本地模式|外部播放器模式|返回本地音乐/);
});

test('the package carries the program, its interface and the licences: no launcher, no mode', () => {
  const pack = read('scripts/package-portable.mjs');
  assert.match(pack, /for \(const name of \['LICENSE', 'NOTICE\.md'\]\) \{/);
  assert.doesNotMatch(pack, /\.cmd'|皮肤|--skin|--local/);
  assert.match(pack, /音乐来源在窗口右上角选择/);
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.deepEqual(tauri.bundle.resources, { '../dist/': 'web/' });
});

// Tauri panics on an error from its setup hook, and the release build (no console) then ends
// without a word: a start that fails must say why itself. The window's WebView2 is watched
// for its processes ending, since the page draws the window's only buttons.
test('a start that fails says why, and the window outlives WebView2 failing under it', () => {
  const main = read('src-tauri/src/main.rs');
  const setup = body(main, '.setup(|app| {', '.build(tauri::generate_context!())');
  assert.match(setup, /if let Err\(error\) = start\(app\) \{\s*startup_failed\(&error\);\s*\}\s*Ok\(\(\)\)\s*\}\)/);
  assert.doesNotMatch(setup.replace(/\/\/[^\n]*/g, ''), /\?|return|Err\((?!error\))/, 'the setup hook itself never fails');
  assert.match(main, /Err\(error\) => startup_failed\(&error\),/);
  assert.match(body(main, 'fn startup_failed(', '\n}\n'), /MessageDialog::new\(\)[\s\S]*\.show\(\);\s*std::process::exit\(1\);/);
  // WebView2 is looked for first, and only named: never downloaded or installed.
  const start = body(main, 'fn start(app: &mut tauri::App)', '\n}\n');
  assert.ok(start.indexOf('tauri::webview_version()') < start.indexOf('portable_paths('), 'WebView2 before anything else');
  assert.match(main, /const WEBVIEW2_MISSING: &str = "[^"]*https:\/\/developer\.microsoft\.com\/microsoft-edge\/webview2\/[^"]*";/);
  assert.deepEqual(JSON.parse(read('src-tauri/tauri.conf.json')).bundle.windows.webviewInstallMode, { type: 'skip' });
  // Every window open_main makes is watched; the page's process ending reloads it, WebView2's own
  // makes the window again ("main", the capability's), and the close that takes is no exit.
  const open = body(main, 'fn open_main(', '\n}\n');
  assert.match(open, /WebviewWindowBuilder::new\(app, "main",[\s\S]*\.decorations\(false\)[\s\S]*watch_webview\(&window\);\s*Ok\(\(\)\)$/);
  assert.deepEqual(JSON.parse(read('src-tauri/capabilities/desktop.json')).windows, ['main']);
  const watch = body(main, 'fn watch_webview(window: &tauri::WebviewWindow) {', '\n}\n');
  assert.match(watch, /RENDER_PROCESS_EXITED[\s\S]*BROWSER_PROCESS_EXITED[\s\S]*add_ProcessFailed/);
  assert.match(watch, /else if page \{\s*if let Some\(core\) = core \{\s*unsafe \{ core\.Reload\(\)\? \};\s*\}\s*\} else \{\s*reopen_main\(app\.clone\(\)\);/);
  assert.match(main, /tauri::RunEvent::ExitRequested \{ code: None, api, \.\. \}\s*if REOPENING\.load\(Ordering::SeqCst\) > 0 =>/);
  // The preferences a start reads are held to the size the page may save.
  assert.match(main, /fn save_preferences\([\s\S]*?if !acceptable_preferences\(&preferences\) \{/);
  assert.match(start, /let preferences = read_preferences\(&data_dir\.join\("preferences\.json"\)\);/);
});

// The page's documents carry app_server.rs's PAGE_POLICY (Tauri's own `csp` reaches only its
// bootstrap page): anything the page needs beyond it stops working in the client.
test('the page runs under the policy its documents carry: no inline script, NetEase covers its only remote images', async () => {
  const server = read('src-tauri/src/app_server.rs');
  const policy = new Map(server.match(/pub const PAGE_POLICY: &str = "([^"]+)";/)[1].split('; ').map((directive) => {
    const [name, ...sources] = directive.split(' ');
    return [name, sources];
  }));
  assert.deepEqual(policy.get('script-src'), ["'self'"]);
  assert.deepEqual(policy.get('object-src'), ["'none'"]);
  for (const source of ["'self'", 'ipc:', 'http://ipc.localhost', 'https://*.music.126.net', 'data:']) assert.ok(policy.get('connect-src').includes(source), source);
  for (const source of ["'self'", 'data:', 'blob:', 'https://*.music.126.net']) assert.ok(policy.get('img-src').includes(source), source);
  // Sent with the page's documents only: /api goes through serve_file, which adds nothing.
  assert.match(server, /let policy = if mime\.starts_with\("text\/html"\) \{\s*vec!\[http::header\("Content-Security-Policy", PAGE_POLICY\)\]/);
  assert.match(read('src-tauri/src/http.rs'), /pub fn serve_file\(request: Request, file: AllowedFile, cache: &str\) \{\s*serve_file_with\(request, file, cache, Vec::new\(\)\)\s*\}/);
  assert.doesNotMatch(read('src-tauri/src/local_music/connector/api.rs'), /serve_file_with|Content-Security-Policy/);
  // NetEase's covers are only ever its public image hosts, over https.
  const cover = body(read('src-tauri/src/netease_music/data/queue.rs'), 'pub(crate) fn cover(', '\n}\n');
  assert.match(cover, /strip_suffix\("\.music\.126\.net"\)/);
  assert.match(cover, /url\.set_scheme\("https"\)/);
  // No inline script, handler, eval or javascript: address: index.html, or markup the page writes.
  const html = read('index.html');
  for (const [, attributes, inline] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) assert.ok(/\ssrc=/.test(attributes) && !inline.trim(), 'a script by its address only');
  assert.doesNotMatch(html, /<[a-z][^<>]*\son[a-z]+\s*=|javascript:|<link[^>]+href="(?:https?:)?\/\//i);
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(new URL('../src/', import.meta.url), { recursive: true }).map(String).filter((file) => file.endsWith('.ts'));
  assert.ok(files.length > 50, 'the page\'s files were read');
  for (const file of files) {
    const text = read(`src/${file.replace(/\\/g, '/')}`);
    assert.doesNotMatch(text, /<[a-z][^<>\n]*\son[a-z]+\s*=/i, `${file}: an inline handler`);
    assert.doesNotMatch(text, /\beval\s*\(|new Function\s*\(|javascript:/, `${file}: script from a string`);
  }
});

// The local music's routes all wait on one store lock (the library, covers, lyrics, a playing song's
// audio). A new main folder is looked for on the disk, which for a network folder whose host does
// not answer takes about 21 s, with that lock released, and not looked for again under it.
test('a new main folder is looked for on the disk with the local music store unlocked', () => {
  const library = read('src-tauri/src/local_music/data/library.rs');
  const api = read('src-tauri/src/local_music/connector/api.rs');
  const scan = body(library, 'pub fn begin_scan(', 'std::thread::spawn(');
  assert.ok(scan.indexOf('Self::checked_main_folder(shared, roots)?') < scan.indexOf('shared.lock()'), 'begin_scan: before the lock');
  assert.match(scan, /update_config_checked\(&json!\(\{"roots":roots\}\), checked\.as_deref\(\)\)\?/);
  assert.match(body(library, 'pub fn checked_main_folder(', '\n    }\n'), /let new = \{\s*let store = shared\.lock\(\)\.unwrap\(\);[^}]*\{[^}]*\}\s*store\.new_main_folder\(roots\)\?\s*\};\s*if let Some\(main\) = &new \{\s*check_main_folder\(main\)\?;/);
  assert.match(body(library, 'pub fn update_config_checked(', '\n    }\n'), /\.filter\(\|main\| checked\.map\(path_key\) != Some\(path_key\(main\)\)\)\s*\{\s*check_main_folder\(main\)\?;/);
  assert.equal(library.match(/fs::metadata\(main\)/g).length, 1, 'only check_main_folder looks');
  const config = body(api, '"/api/config" | "/api/library/config" if post => {', '"/api/genre-rules" if get');
  assert.ok(config.indexOf('Store::checked_main_folder(store, roots)') >= 0 && config.indexOf('Store::checked_main_folder(store, roots)') < config.indexOf('store.lock()'), '/api/config: before the lock');
  assert.match(config, /update_config_checked\(input, checked\.as_deref\(\)\)/);
});
