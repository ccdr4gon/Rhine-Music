import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Run the production controller without a DOM/WebGL dependency. Transpilation
// also supports its TypeScript parameter properties on Node's strip-only builds.
const source = await readFile(new URL('../src/music-presentation.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { MusicPresentation } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function fixture({ reduced = false } = {}) {
  const events = [];
  const menuExits = [];
  const browseExits = [];
  const ready = { presentation: false, archive: true };
  const ports = {
    presentationReady: () => ready.presentation,
    archiveReady: () => ready.archive,
    enterCamera() {
      events.push('camera:enter');
      ready.archive = false;
      ready.presentation = reduced;
    },
    returnCamera() {
      events.push('camera:return');
      ready.presentation = false;
      ready.archive = reduced;
    },
    select(selection) {
      events.push({ select: structuredClone(selection) });
      ready.archive = reduced;
    },
    switchDetail(selection) {
      events.push({ switchDetail: structuredClone(selection) });
      ready.archive = false;
      ready.presentation = reduced;
    },
    prepareMenu: () => events.push('menu:prepare'),
    showMenu: () => events.push('menu:show'),
    hideMenu(done) {
      events.push('menu:hide');
      if (reduced) done();
      else menuExits.push(done);
    },
    hideBrowse(done) {
      events.push('browse:hide');
      if (reduced) done();
      else browseExits.push(done);
    },
    showBrowse: () => events.push('browse:show'),
    mode: (mode) => events.push(`mode:${mode}`),
  };
  const motion = new MusicPresentation(ports);
  const finishBrowse = () => {
    assert.ok(browseExits.length, 'A browse exit must be pending');
    browseExits.shift()();
  };
  const finishMenu = () => {
    assert.ok(menuExits.length, 'A menu exit must be pending');
    menuExits.shift()();
  };
  const openDetail = () => {
    motion.open();
    if (!reduced) finishBrowse();
    ready.presentation = true;
    motion.update();
    assert.equal(motion.phase, 'detail');
  };
  const selections = () => events.filter((event) => typeof event === 'object' && 'select' in event).map((event) => event.select);
  const detailSelections = () => events.filter((event) => typeof event === 'object' && 'switchDetail' in event).map((event) => event.switchDetail);
  return { motion, events, ready, ports, finishBrowse, finishMenu, openDetail, selections, detailSelections, browseExits, menuExits };
}

test('menu waits for both browse exit and completed elevated camera presentation', () => {
  const f = fixture();
  f.motion.open();
  assert.equal(f.motion.phase, 'opening');
  assert.equal(f.events.filter((event) => event === 'menu:show').length, 0);
  // A camera readiness signal by itself may not expose an overlapping menu.
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  f.ready.presentation = false;
  f.finishBrowse();
  for (let frame = 0; frame < 120; frame++) f.motion.update();
  assert.equal(f.motion.phase, 'opening', 'Elapsed frames cannot replace camera readiness');
  assert.ok(!f.events.includes('menu:show'));
  f.ready.presentation = true;
  f.motion.update();
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.equal(f.events.filter((event) => event === 'menu:show').length, 1);
});

test('detail switch waits for menu exit and new presentation without returning to the archive', () => {
  const f = fixture();
  f.openDetail();
  f.events.length = 0;
  f.motion.select({ index: 4 }, true);
  assert.equal(f.motion.phase, 'switch-hiding');
  f.ready.presentation = true; // Even a stale ready flag cannot bypass the menu exit.
  f.motion.update();
  assert.deepEqual(f.events, ['menu:hide']);
  f.finishMenu();
  assert.deepEqual(f.events, ['menu:hide', { switchDetail: { index: 4 } }, 'menu:prepare']);
  assert.equal(f.motion.phase, 'switching');
  assert.equal(f.motion.openingOrDetail, true);
  f.motion.update();
  assert.equal(f.motion.phase, 'switching', 'Wait for the new camera/album presentation');
  assert.ok(!f.events.includes('menu:show'));
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.equal(f.events.at(-1), 'menu:show');
  assert.deepEqual(f.selections(), [], 'Archive selection must not interrupt the detail camera');
  assert.ok(!f.events.some((event) => ['mode:archive', 'camera:return', 'camera:enter', 'browse:hide', 'browse:show'].includes(event)));
});

for (const startingPhase of ['detail', 'opening', 'switch-hiding', 'switching']) {
  test(`search from ${startingPhase} returns to the archive, settles its selection, then reopens`, () => {
    const f = fixture();
    if (startingPhase === 'opening') f.motion.open();
    else f.openDetail();
    if (startingPhase === 'switch-hiding' || startingPhase === 'switching') {
      f.motion.select({ index: 1 }, true);
      if (startingPhase === 'switching') f.finishMenu();
    }
    f.events.length = 0;
    const target = { index: 8, route: 'archive' };
    f.motion.select(target, true);
    assert.equal(f.menuExits.length, 1, 'Reuse an existing text exit rather than starting a second one');
    if (startingPhase === 'opening') f.finishBrowse(); // Obsolete first-opening callback.
    f.ready.presentation = true;
    f.motion.update();
    assert.deepEqual(f.detailSelections(), [], 'Search must not use the accelerated detail rail');
    assert.deepEqual(f.selections(), [], 'Keep the target pending while text leaves');
    f.finishMenu();
    assert.equal(f.motion.phase, 'returning');
    assert.ok(f.events.includes('camera:return'));
    f.ports.archiveInteractive = () => true;
    f.motion.update();
    assert.deepEqual(f.selections(), [], 'Search must wait for full archive readiness, not just interactivity');
    f.ready.archive = true;
    f.motion.update();
    assert.equal(f.motion.phase, 'selecting');
    assert.deepEqual(f.selections(), [target]);
    f.motion.update();
    assert.equal(f.motion.phase, 'selecting', 'Do not open before the new row and lane settle');
    f.ready.archive = true;
    f.motion.update();
    assert.equal(f.motion.phase, 'opening');
    assert.equal(f.events.filter((event) => event === 'camera:enter').length, 1);
    f.finishBrowse();
    f.ready.presentation = true;
    f.motion.update();
    assert.equal(f.motion.phase, 'detail');
    assert.deepEqual(f.detailSelections(), []);
    assert.equal(f.events.at(-1), 'menu:show');
  });
}

test('search replacements during exit, return and row movement preserve the latest destination', () => {
  const f = fixture();
  f.openDetail();
  f.events.length = 0;
  f.motion.select({ index: 2, route: 'archive' }, true);
  f.motion.select({ index: 3, route: 'archive' }, true);
  assert.equal(f.menuExits.length, 1);
  f.finishMenu();
  const duringReturn = { index: 4, route: 'archive' };
  f.motion.select(duringReturn, true);
  f.ready.archive = true;
  f.motion.update();
  const duringSelection = { index: 6, route: 'archive' };
  f.motion.select(duringSelection, true);
  f.ready.archive = true;
  f.motion.update();
  assert.deepEqual(f.selections(), [duringReturn, duringSelection]);
  assert.deepEqual(f.detailSelections(), []);
  assert.ok(!f.events.includes('camera:enter'), 'Do not briefly open an obsolete search destination');
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  assert.equal(f.events.filter((event) => event === 'camera:return').length, 1);
  assert.equal(f.events.filter((event) => event === 'camera:enter').length, 1);
});

for (const cancelPhase of ['hiding', 'returning', 'selecting']) {
  test(`back during search ${cancelPhase} cancels reopening`, () => {
    const f = fixture();
    f.openDetail();
    f.events.length = 0;
    f.motion.select({ index: 5, route: 'archive' }, true);
    if (cancelPhase !== 'hiding') f.finishMenu();
    if (cancelPhase === 'selecting') {
      f.ready.archive = true;
      f.motion.update();
    }
    assert.equal(f.motion.phase, cancelPhase);
    f.motion.back();
    if (cancelPhase === 'hiding') f.finishMenu();
    f.ready.archive = true;
    f.motion.update();
    assert.equal(f.motion.phase, 'archive');
    assert.equal(f.motion.pendingSelection, undefined);
    assert.equal(f.motion.openingOrDetail, false);
    assert.ok(!f.events.includes('camera:enter'));
    assert.deepEqual(f.detailSelections(), []);
    assert.equal(f.selections().length, cancelPhase === 'selecting' ? 1 : 0);
  });
}

test('reduced-motion search preserves archive selection and reopen ordering', () => {
  const f = fixture({ reduced: true });
  f.openDetail();
  f.events.length = 0;
  const target = { index: 2, route: 'archive' };
  f.motion.select(target, true);
  assert.equal(f.motion.phase, 'returning');
  f.motion.update();
  assert.equal(f.motion.phase, 'selecting');
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.deepEqual(f.events, [
    'menu:hide', 'mode:archive', 'camera:return', { select: target },
    'mode:detail', 'menu:prepare', 'browse:hide', 'camera:enter', 'menu:show',
  ]);
});

test('rapid requests retain the latest selection and its navigation intent', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 1 }, true);
  f.motion.select({ index: 2 }, true);
  assert.equal(f.menuExits.length, 1, 'Rapid input must not restart the menu exit');
  f.finishMenu();
  assert.deepEqual(f.detailSelections(), [{ index: 2 }]);
  const final = { index: 9, navigation: { axis: 'lane', direction: -1 } };
  f.motion.select(final, true);
  assert.deepEqual(f.motion.pendingSelection, final);
  f.ready.presentation = true; // This readiness belongs to the superseded target.
  f.motion.update();
  assert.deepEqual(f.selections(), []);
  assert.deepEqual(f.detailSelections(), [{ index: 2 }, final]);
  assert.equal(f.motion.phase, 'switching');
  assert.equal(f.events.filter((event) => event === 'menu:show').length, 1, 'Do not reveal a target committed on the same frame');
  f.motion.select({ index: 10 }, true);
  f.motion.select({ index: 12 }, false);
  assert.equal(f.motion.phase, 'hiding');
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.deepEqual(f.detailSelections(), [{ index: 2 }, final], 'A pending detail target is replaced by archive selection');
  assert.deepEqual(f.selections(), [{ index: 12 }]);
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.equal(f.events.at(-1), 'browse:show');
});

test('back during text exit cancels the pending detail switch and returns once', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 3 }, true);
  f.motion.back();
  assert.equal(f.motion.pendingSelection, undefined);
  assert.equal(f.menuExits.length, 1, 'Back must reuse the in-flight text exit');
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.deepEqual(f.selections(), []);
  assert.deepEqual(f.detailSelections(), []);
  assert.equal(f.events.filter((event) => event === 'camera:enter').length, 1);
  assert.equal(f.events.filter((event) => event === 'camera:return').length, 1);
});

test('latest back during a committed rail movement settles into browsing', () => {
  const f = fixture();
  f.motion.select({ index: 7 }, true);
  assert.equal(f.motion.phase, 'selecting');
  f.motion.select({ index: 8 }, true);
  f.motion.back();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.deepEqual(f.selections(), [{ index: 7 }]);
  assert.ok(!f.events.includes('camera:enter'));
});

test('replay/reset invalidates old menu-exit callbacks', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 5 }, true);
  f.motion.reset();
  f.events.length = 0;
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.equal(f.motion.pendingSelection, undefined);
  assert.equal(f.motion.openingOrDetail, false);
  assert.deepEqual(f.events, [], 'A callback from the previous opening cannot move the new scene');
});

test('skip/replay handoff cannot use an old browse exit to reveal the new menu', () => {
  const f = fixture();
  f.motion.open();
  f.motion.reset();
  f.ready.archive = true; // The replacement scene has completed its skip/replay handoff.
  f.motion.open();
  f.ready.presentation = true;
  f.finishBrowse(); // Completion from before reset.
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  assert.ok(!f.events.includes('menu:show'));
  f.finishBrowse();
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
});

test('interrupted opening ignores stale callbacks and honours a later open request', () => {
  const f = fixture();
  f.motion.open();
  f.motion.back();
  f.motion.open();
  f.finishBrowse();
  f.ready.presentation = true;
  f.motion.update();
  assert.ok(!f.events.includes('menu:show'));
  f.finishMenu();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'opening');
  f.finishBrowse();
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
});

test('reduced-motion synchronous callbacks preserve ordering and never deadlock', () => {
  const f = fixture({ reduced: true });
  f.openDetail();
  f.events.length = 0;
  f.motion.select({ index: 2 }, true);
  assert.equal(f.motion.phase, 'switching');
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.deepEqual(f.events, [
    'menu:hide', { switchDetail: { index: 2 } }, 'menu:prepare', 'menu:show',
  ]);
  f.motion.back();
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.equal(f.events.at(-1), 'browse:show');
});

test('enabling reduced motion during an exit can finish existing callbacks safely', () => {
  const f = fixture();
  f.openDetail();
  f.motion.select({ index: 3 }, false);
  f.finishMenu();
  // Real ports snap the camera and drain their existing transition callbacks.
  f.ready.archive = true;
  f.motion.update();
  f.ready.archive = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'archive');
  assert.deepEqual(f.selections(), [{ index: 3 }]);
  assert.equal(f.events.at(-1), 'browse:show');
});

const transitionSource = await readFile(new URL('../src/ui-transitions.ts', import.meta.url), 'utf8');
const transitionModule = ts.transpileModule(transitionSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { SurfaceTransition, DETAIL_SCENE, DETAIL_SWAP, SONG_SCENE } = await import(`data:text/javascript;base64,${Buffer.from(transitionModule).toString('base64')}`);

function animationElement(hidden = false) {
  const element = { hidden, dataset: {}, opacity: '1', transform: 'none', animations: [],
    style: { visibility: '', removeProperty(name) { this[name] = ''; } } };
  element.animate = (frames, options) => {
    let resolve, reject, finished;
    let settled = false, cancelled = false;
    const animation = {
      frames, options,
      get finished() {
        // Native Animation.finished is only observed when its getter is used.
        return finished ??= new Promise((done, fail) => {
          resolve = done;
          reject = fail;
          if (cancelled) fail(new Error('cancelled'));
          else if (settled) done();
        });
      },
      finish() { settled = true; resolve?.(); },
      cancel() { cancelled = true; reject?.(new Error('cancelled')); },
    };
    element.animations.push(animation);
    return animation;
  };
  return element;
}

test('production document swap rises and fades before switching the detail album, and returns after 70 ms', async (t) => {
  const originalComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (element) => element;
  t.after(() => { globalThis.getComputedStyle = originalComputedStyle; });
  // The details' previous / next (2026-10-05 design): only the document leaves, 170 ms, 6 px up.
  const article = animationElement();
  const transition = new SurfaceTransition(article, article, 250, 170, DETAIL_SWAP);
  const f = fixture();
  f.openDetail();
  f.ports.hideMenu = (done) => transition.hide(false, done);
  f.motion.select({ index: 6 }, true);
  assert.equal(article.hidden, false, 'Retain the document while its outgoing frames render');
  assert.equal(article.dataset.transition, 'closing');
  // The surface is its own panel: one fade and one movement.
  const latest = (property) => article.animations.findLast((animation) => property in animation.frames[0]);
  assert.equal(latest('opacity').options.duration, 170);
  assert.equal(latest('opacity').frames.at(-1).opacity, 0);
  assert.equal(latest('transform').frames.at(-1).transform, 'translateY(-6px)', 'Exit rises 6 px');
  assert.ok(!f.events.includes('camera:return'));
  assert.deepEqual(f.detailSelections(), [], 'Do not move the album before its text exits');
  transition.finish();
  await Promise.resolve();
  await Promise.resolve();
  // Held: still laid out (its new content is prepared in place), invisible until it returns.
  assert.equal(article.hidden, false);
  assert.equal(article.style.visibility, 'hidden');
  assert.equal(article.dataset.transition, 'closed');
  assert.equal(f.motion.phase, 'switching');
  assert.deepEqual(f.detailSelections(), [{ index: 6 }]);
  assert.equal(f.events.at(-1), 'menu:prepare');
  assert.ok(!f.events.includes('camera:return'));
  // Back from where it went, 250 ms after a 70 ms pause, once shown again.
  transition.show(false);
  assert.equal(article.style.visibility, '');
  assert.equal(latest('transform').options.duration, 250);
  assert.equal(latest('transform').options.delay, 70);
  assert.equal(latest('transform').frames[0].transform, 'translateY(-6px)');
  assert.equal(latest('opacity').options.delay, 70);
  assert.equal(latest('opacity').frames[0].opacity, '0');
});

test('production details page sinks 6 px as it fades out and rises 6 px into place', async (t) => {
  const originalComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (element) => element;
  t.after(() => { globalThis.getComputedStyle = originalComputedStyle; });
  const root = animationElement();
  const transition = new SurfaceTransition(root, root, 420, 200, DETAIL_SCENE);
  transition.hide(false);
  const latest = (property) => root.animations.findLast((animation) => property in animation.frames[0]);
  assert.equal(latest('opacity').options.duration, 200);
  assert.equal(latest('opacity').frames.at(-1).opacity, 0);
  assert.equal(latest('transform').frames.at(-1).transform, 'translateY(6px)');
  transition.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(root.hidden, true, 'A page that is not held is hidden when it has left');
  transition.show(false);
  assert.equal(latest('transform').options.duration, 420);
  assert.equal(latest('transform').options.delay, 0);
  assert.equal(latest('transform').frames[0].transform, 'translateY(6px)');
});

test('production song scene: its chrome and pane rise 6 px with translate as they fade in, sink as they fade out; the section never moves', async (t) => {
  const originalComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (element) => element;
  t.after(() => { globalThis.getComputedStyle = originalComputedStyle; });
  const section = animationElement(true), chrome = animationElement(), pane = animationElement();
  // The pane keeps its own transform (its turn): the rise is the individual translate property.
  pane.transform = 'perspective(1660px) rotateY(-18deg)';
  chrome.translate = pane.translate = 'none';
  const transition = new SurfaceTransition(section, undefined, 420, 200, SONG_SCENE, undefined, [chrome, pane]);
  transition.show(false);
  assert.equal(section.animations.length, 0, 'the section itself is never animated');
  for (const target of [chrome, pane]) {
    const [fade] = target.animations;
    assert.equal(fade.options.duration, 420);
    assert.deepEqual(fade.frames, [{ opacity: '0', translate: '0 6px' }, { opacity: 1, translate: '0 0' }]);
    assert.ok(fade.frames.every((frame) => !('transform' in frame)), 'the pane\'s turn is left alone');
  }
  transition.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(section.hidden, false);
  transition.hide(false);
  for (const target of [chrome, pane]) {
    const fade = target.animations.at(-1);
    assert.equal(fade.options.duration, 200);
    assert.deepEqual(fade.frames.at(-1), { opacity: 0, translate: '0 6px' });
    assert.equal(fade.frames[0].translate, '0 0', 'from where it rests');
  }
  // Interrupted half way: it turns back from where it got to.
  pane.translate = '0px 3px';
  pane.opacity = '0.5';
  transition.show(false);
  assert.deepEqual(pane.animations.at(-1).frames[0], { opacity: '0.5', translate: '0px 3px' });
});

test('production transition cancellation cannot complete an obsolete exit', async (t) => {
  const originalComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (element) => element;
  t.after(() => { globalThis.getComputedStyle = originalComputedStyle; });
  const root = animationElement(), article = animationElement();
  const transition = new SurfaceTransition(root, article, 420, 200, DETAIL_SCENE);
  let obsoleteCalls = 0;
  transition.hide(false, () => { obsoleteCalls++; });
  const oldFade = root.animations.at(-1);
  root.opacity = '0.37'; // The browser's current interpolated style on interruption.
  article.transform = 'matrix(1, 0, 0, 1, 23, 0)';
  transition.show(false);
  assert.equal(root.animations.at(-1).frames[0].opacity, '0.37');
  assert.equal(article.animations.at(-1).frames[0].transform, article.transform);
  oldFade.finish();
  transition.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(obsoleteCalls, 0);
  assert.equal(root.hidden, false);
  assert.equal(root.dataset.transition, 'open');
  let reducedCalls = 0;
  transition.hide(true, () => { reducedCalls++; });
  assert.equal(reducedCalls, 1, 'Reduced motion completes synchronously');
  assert.equal(root.hidden, true);
});

test('swapping the opened menu hides its text, retargets the scene and waits for it without leaving', () => {
  const f = fixture();
  f.openDetail();
  f.events.length = 0;
  let changed = 0;
  assert.equal(f.motion.swapMenu(() => { changed++; f.ready.presentation = false; f.events.push('scene:retarget'); }), true);
  assert.equal(f.motion.phase, 'switch-hiding');
  assert.equal(changed, 0, 'The scene keeps its framing until the text has left');
  f.motion.update();
  assert.deepEqual(f.events, ['menu:hide']);
  f.finishMenu();
  assert.deepEqual(f.events, ['menu:hide', 'scene:retarget', 'menu:prepare']);
  assert.equal(f.motion.phase, 'switching');
  for (let frame = 0; frame < 60; frame++) f.motion.update();
  assert.equal(f.motion.phase, 'switching', 'Wait for the new framing');
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.equal(f.events.at(-1), 'menu:show');
  assert.equal(f.motion.openingOrDetail, true);
  assert.ok(!f.events.some((event) => ['mode:archive', 'camera:return', 'camera:enter', 'browse:hide', 'browse:show'].includes(event)));
});

test('a menu swap is refused while the album is opening or its text is leaving', () => {
  const f = fixture();
  let changed = 0;
  assert.equal(f.motion.swapMenu(() => { changed++; }), false, 'Not from the archive');
  f.motion.open();
  assert.equal(f.motion.swapMenu(() => { changed++; }), false, 'Not while opening');
  f.finishBrowse();
  f.ready.presentation = true;
  f.motion.update();
  f.motion.select({ index: 3 }, true);
  assert.equal(f.motion.swapMenu(() => { changed++; }), false, 'Not during an album switch');
  assert.equal(changed, 0);
  assert.equal(f.events.filter((event) => event === 'menu:hide').length, 1);
});

test('Escape during a menu swap returns to the archive without retargeting the scene', () => {
  const f = fixture();
  f.openDetail();
  f.events.length = 0;
  let changed = 0;
  f.motion.swapMenu(() => { changed++; });
  f.motion.back();
  assert.equal(f.menuExits.length, 1, 'Reuse the text exit already in progress');
  f.finishMenu();
  assert.equal(changed, 0);
  assert.equal(f.motion.phase, 'returning');
  assert.deepEqual(f.events, ['menu:hide', 'mode:archive', 'camera:return']);
});

test('a selection made during a menu swap is committed after the swap, in the new menu', () => {
  const f = fixture();
  f.openDetail();
  f.events.length = 0;
  f.motion.swapMenu(() => f.events.push('scene:retarget'));
  f.motion.select({ index: 5 }, true);
  assert.equal(f.menuExits.length, 1);
  f.finishMenu();
  assert.deepEqual(f.events, ['menu:hide', 'scene:retarget', { switchDetail: { index: 5 } }, 'menu:prepare']);
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.equal(f.events.at(-1), 'menu:show');
});

test('a menu that stays in place may finish its exit at once', () => {
  // The song scene keeps its panel while the playlist moves: hideMenu calls back synchronously.
  const f = fixture();
  f.openDetail();
  f.events.length = 0;
  f.ports.hideMenu = (done) => { f.events.push('menu:stay'); done(); };
  f.motion.select({ index: 2 }, true);
  assert.deepEqual(f.events, ['menu:stay', { switchDetail: { index: 2 } }, 'menu:prepare']);
  assert.equal(f.motion.phase, 'switching');
  // A second request before the scene is ready replaces nothing visible and is not lost.
  f.motion.select({ index: 4 }, true);
  f.motion.update();
  assert.deepEqual(f.detailSelections(), [{ index: 2 }, { index: 4 }]);
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.equal(f.events.at(-1), 'menu:show');
});

test('a menu swap is accepted while the scene is still arriving, and carries a pending selection', () => {
  // Esc in the song scene during an in-place switch must still return to the detail it was
  // opened from, not fall through to the shelf.
  const f = fixture();
  f.openDetail();
  f.events.length = 0;
  f.motion.select({ index: 6 }, true);
  f.finishMenu();
  assert.equal(f.motion.phase, 'switching');
  f.ready.presentation = false;
  let changed = 0;
  assert.equal(f.motion.swapMenu(() => { changed++; f.events.push('scene:retarget'); }), true);
  assert.equal(f.motion.phase, 'switch-hiding');
  // A further selection arrives while the text of the old menu is leaving.
  f.motion.select({ index: 7 }, true);
  f.finishMenu();
  assert.equal(changed, 1);
  assert.deepEqual(f.events.slice(-3), ['scene:retarget', { switchDetail: { index: 7 } }, 'menu:prepare']);
  assert.equal(f.motion.phase, 'switching');
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.equal(f.events.at(-1), 'menu:show');
  assert.ok(!f.events.some((event) => ['mode:archive', 'camera:return', 'browse:show'].includes(event)));
});

test('a menu swap right after another one reverses it without visiting the shelf', () => {
  const f = fixture();
  f.openDetail();
  f.events.length = 0;
  const order = [];
  f.motion.swapMenu(() => order.push('to song'));
  f.finishMenu();
  assert.equal(f.motion.phase, 'switching');
  f.ready.presentation = false;
  assert.equal(f.motion.swapMenu(() => order.push('to detail')), true);
  f.finishMenu();
  assert.deepEqual(order, ['to song', 'to detail']);
  f.ready.presentation = true;
  f.motion.update();
  assert.equal(f.motion.phase, 'detail');
  assert.equal(f.events.filter((event) => event === 'menu:show').length, 1);
  assert.ok(!f.events.includes('camera:return'));
});
