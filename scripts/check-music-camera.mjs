import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MusicCameraMotion, MusicPlacementMotion, MusicPresentation, musicArchiveTracksSettled, musicCinematicPose, musicExtractionAnchor,
  MUSIC_LENS, musicLens } from '../src/music-camera.ts';
import { damp } from '../src/motion.ts';
import { BokehShader } from 'three/addons/shaders/BokehShader.js';
import { focalShader } from '../src/depth-of-field.ts';
import { COLUMN_SPACING, ROW_SPACING } from '../src/archive-loop.ts';
import { MUSIC_MODEL } from '../src/music-model.ts';
import { SONG_CHAIN_CENTRE, SONG_VIEW, songChainPose } from '../src/song-pose.ts';

function setup() {
  const camera = new THREE.PerspectiveCamera();
  const aim = new THREE.Vector3();
  camera.position.set(-62, 36, 43);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(7.33 / (2 * camera.position.length())));
  const motion = new MusicCameraMotion();
  motion.observe(camera, aim, 0);
  return { camera, aim, motion };
}
const span = (camera, aim) => 2 * camera.position.distanceTo(aim) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
const target = new THREE.Vector3(-20, 17, 67), focus = new THREE.Vector3(2, 1, 0);
const a = setup(), b = setup();
const start = a.camera.position.clone();
a.motion.update(a.camera, a.aim, target, focus, 7.33, .1, false);
for (let frame = 0; frame < 12; frame++) b.motion.update(b.camera, b.aim, target, focus, 7.33, 1 / 120, false);
assert.ok(a.camera.position.distanceTo(b.camera.position) < 1e-9, 'Dolly is stable across frame rates');
assert.ok(a.aim.distanceTo(b.aim) < 1e-9);
assert.ok(a.camera.position.distanceTo(start) < target.distanceTo(start) * .25, 'The first 100 ms starts gently');
assert.ok(Math.abs(span(a.camera, a.aim) - 7.33) < 1e-9, 'Distance change does not produce a scale pulse');
const before = a.camera.position.clone();
a.motion.update(a.camera, a.aim, start, new THREE.Vector3(), 7.33, 1 / 120, false);
assert.ok(a.camera.position.x > before.x, 'A rapid reversal preserves existing velocity before braking');
for (let frame = 0; frame < 300; frame++) a.motion.update(a.camera, a.aim, start, new THREE.Vector3(), 5.9, 1 / 60, false);
assert.ok(a.camera.position.distanceTo(start) < 1e-10 && Math.abs(span(a.camera, a.aim) - 5.9) < 1e-10, 'Camera settles to exact framing');
a.motion.update(a.camera, a.aim, target, focus, 5.9, 0, true);
assert.deepEqual(a.camera.position.toArray(), target.toArray(), 'Reduced motion snaps');
assert.deepEqual(a.aim.toArray(), focus.toArray());

const film = setup();
film.camera.position.x += .1;
film.motion.observe(film.camera, film.aim, 1 / 60);
const handoff = film.camera.position.clone();
film.motion.update(film.camera, film.aim, handoff, film.aim.clone(), 7.33, 1 / 120, false);
assert.ok(film.camera.position.x > handoff.x, 'Opening camera velocity survives the interactive handoff');
assert.ok(film.camera.position.distanceTo(handoff) < .1, 'Handoff is continuous');

assert.deepEqual(musicExtractionAnchor(27.3), { x: 518, y: 288 }, 'Extraction starts at the previous shot corner');
const next = musicExtractionAnchor(27.3 + .001);
assert.ok(Math.hypot(next.x - 518, next.y - 288) < .000001, 'The shot boundary has no anchor jump');
const end = musicExtractionAnchor(34);
assert.deepEqual(end, { x: 420, y: 330 }, 'Oblique inspection holds its corner before the separate centering move');
assert.deepEqual(musicCinematicPose(29), musicCinematicPose(32.5), 'The close oblique shot has a real inspection pause');
const front = musicCinematicPose(34.56);
assert.deepEqual(front, { yaw: 0, elevation: 0, centered: 1, detail: 1 }, 'Film finishes face-on and centered');
const navigation = setup();
for (let frame = 0; frame < 180; frame++) {
  const orbit = navigation.motion.navigation(4, -5, 0, 1 / 60, false);
  assert.ok(Math.abs(orbit.yaw) <= .018 && Math.abs(orbit.elevation) <= .006, 'Browsing orbit stays subtle');
}
assert.deepEqual(navigation.motion.navigation(10, 10, 0, 0, true), { yaw: 0, elevation: 0 });

function verifyPresentation(hz, reduced = false) {
  const presentation = new MusicPresentation();
  const pan = new MusicPlacementMotion();
  const rig = setup();
  const archiveCamera = rig.camera.position.clone();
  const detailAim = new THREE.Vector3(2.6222222222, 1.85, 0);
  const yaw = THREE.MathUtils.degToRad(8), elevation = THREE.MathUtils.degToRad(20);
  const detailCamera = detailAim.clone().addScaledVector(new THREE.Vector3(
    -Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation),
  ), 72);
  const pose = (progress) => ({
    aim: detailAim.clone().multiplyScalar(progress),
    camera: archiveCamera.clone().lerp(detailCamera, progress),
    height: 7.33 + (5.9 - 7.33) * progress,
  });
  presentation.request('detail');
  assert.equal(presentation.phase, 'placing', 'Extraction and placement start in the same phase');
  assert.equal(presentation.placed, true, 'The shared movement starts without a frontal-centering gate');
  assert.equal(presentation.holdsDetail, true);
  const history = [presentation.phase];
  presentation.update(1, false, true, reduced);
  assert.equal(presentation.phase, 'placing', 'Placement readiness cannot bypass a moving camera');
  presentation.update(1, true, false, reduced);
  assert.equal(presentation.phase, 'placing', 'Camera readiness cannot bypass a moving extraction');
  for (let frame = 0; frame < hz * 8; frame++) {
    const progress = pan.update(Number(presentation.holdsDetail), 1 / hz, reduced);
    if (frame === 0) assert.ok(progress > 0, 'The first entry frame advances the common movement');
    const { aim, camera, height } = pose(progress);
    rig.motion.update(rig.camera, rig.aim, camera, aim, height, 1 / hz, reduced);
    const previous = presentation.phase;
    presentation.update(1 / hz,
      rig.motion.isSettled(rig.camera, rig.aim, camera, aim, height), pan.settled, reduced);
    if (previous !== presentation.phase) {
      history.push(presentation.phase);
      assert.ok(pan.settled, 'Presentation waits for the common extraction and placement endpoint');
      assert.ok(rig.motion.isSettled(rig.camera, rig.aim, camera, aim, height),
        'Presentation also waits for the displayed camera to settle');
    }
    if (presentation.phase === 'presented') break;
  }
  assert.deepEqual(history, ['placing', 'presented']);
  const displayedDirection = rig.camera.position.clone().sub(rig.aim).normalize();
  assert.ok(Math.abs(Math.asin(displayedDirection.y) - elevation) < .001,
    'The displayed detail camera preserves the elevated inspection angle');
  presentation.request('archive');
  assert.equal(presentation.phase, 'returning-center');
  presentation.returnWhenAligned(false);
  presentation.update(1, true, true, reduced);
  assert.equal(presentation.phase, 'returning-center', 'A manually rotated box must align before returning');
  assert.equal(presentation.holdsDetail, true, 'Alignment holds the shared extraction and camera endpoint');
  assert.equal(pan.update(Number(presentation.holdsDetail), 1 / hz, reduced), 1);
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'returning-array', 'An aligned box begins the common return immediately');
  assert.equal(presentation.holdsDetail, false);
  history.push(presentation.phase);
  for (let frame = 0; frame < hz * 8; frame++) {
    const progress = pan.update(Number(presentation.holdsDetail), 1 / hz, reduced);
    const { aim, camera, height } = pose(progress);
    rig.motion.update(rig.camera, rig.aim, camera, aim, height, 1 / hz, reduced);
    const previous = presentation.phase;
    presentation.update(1 / hz,
      rig.motion.isSettled(rig.camera, rig.aim, camera, aim, height), pan.settled, reduced);
    if (previous !== presentation.phase) history.push(presentation.phase);
    if (presentation.phase === 'archive') break;
  }
  assert.deepEqual(history, ['placing', 'presented', 'returning-array', 'archive']);
  presentation.request('detail');
  presentation.request('archive');
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'returning-array', 'An unrotated entry can reverse on its first return frame');
  presentation.request('detail');
  assert.equal(presentation.phase, 'placing', 'Rapid reversal resumes the same shared movement');
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'placing', 'A stale alignment signal cannot undo a reopened detail');
  presentation.request('hidden');
  presentation.returnWhenAligned(true);
  assert.equal(presentation.phase, 'hidden', 'Replay clears all readiness');
  presentation.request('archive');
  assert.equal(presentation.phase, 'returning-array', 'Skip waits for the archive camera');
}
verifyPresentation(30);
verifyPresentation(120);
verifyPresentation(30, true);

function measurePan(hz) {
  const camera = new THREE.PerspectiveCamera();
  const aim = new THREE.Vector3(0, 1.85, 0);
  camera.position.set(0, 1.85, 72);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(5.9 / 144));
  const motion = new MusicCameraMotion(), pan = new MusicPlacementMotion();
  motion.observe(camera, aim, 0);
  const shift = 5.9 * 16 / 9 * .25;
  let early = 0, t95 = null, previous = 0;
  for (let frame = 1; frame <= hz * 3; frame++) {
    const progress = pan.update(1, 1 / hz, false);
    const targetAim = new THREE.Vector3(progress * shift, 1.85, 0);
    const targetCamera = targetAim.clone().add(new THREE.Vector3(0, 0, 72));
    motion.update(camera, aim, targetCamera, targetAim, 5.9, 1 / hz, false);
    const displayed = aim.x / shift;
    assert.ok(displayed >= previous && displayed <= 1 + 1e-10, 'A full pan has no reversal or overshoot');
    previous = displayed;
    if (frame === hz / 5) early = displayed;
    if (t95 === null && displayed >= .95) t95 = frame / hz;
  }
  assert.ok(early < .005, 'The first 200 ms gently accelerates instead of travelling half the distance');
  assert.ok(t95 > 1.4 && t95 < 1.55, 'Actual 95% travel follows the long deceleration timing');
  return { early, t95 };
}
const pan30 = measurePan(30), pan120 = measurePan(120), pan240 = measurePan(240);
assert.ok(Math.abs(pan30.t95 - pan120.t95) < .05, 'Pan timing is stable at 30 and 120 Hz');
const interruptedPan = new MusicPlacementMotion();
interruptedPan.update(1, .55, false);
const state = [interruptedPan.value, interruptedPan.velocity, interruptedPan.acceleration];
interruptedPan.update(0, 0, false);
assert.deepEqual([interruptedPan.value, interruptedPan.velocity, interruptedPan.acceleration], state,
  'Retargeting the pan preserves position, velocity and acceleration');
interruptedPan.update(0, 1e-5, false);
assert.ok(Math.abs(interruptedPan.value - state[0]) < .0001 && Math.abs(interruptedPan.velocity - state[1]) < .001,
  'The first interrupted frame is continuous');
interruptedPan.update(1, 0, true);
assert.equal(interruptedPan.value, 1);
assert.equal(interruptedPan.velocity, 0);
assert.equal(interruptedPan.settled, true);

for (const hz of [30, 120]) {
  const presentation = new MusicPresentation();
  presentation.request('archive');
  presentation.update(.1, true, true, false);
  assert.equal(presentation.phase, 'archive');
  const tracks = Object.fromEntries(['rail', 'column', 'shoulder', 'lane'].map(key => [key, { value: 0, velocity: 0 }]));
  let targets = { rail: -.62, column: 5.2, shoulder: 1, lane: 1 };
  presentation.selectionChanged();
  assert.equal(presentation.phase, 'returning-array', 'Selecting a new cell invalidates readiness immediately');
  for (let frame = 0; frame < hz / 5; frame++) {
    for (const key of Object.keys(tracks)) damp(tracks[key], targets[key], 3.7, 1 / hz);
    presentation.update(1 / hz, true, musicArchiveTracksSettled(tracks, targets), false);
  }
  assert.equal(presentation.phase, 'returning-array', 'A settled camera cannot bypass the moving selection tracks');
  const previousSpeed = tracks.column.velocity;
  targets = { rail: -1.24, column: -5.2, shoulder: 2, lane: -1 };
  presentation.selectionChanged();
  assert.equal(tracks.column.velocity, previousSpeed, 'Rapid browsing keeps the existing track velocity');
  for (let frame = 0; frame < hz * 5; frame++) {
    for (const key of Object.keys(tracks)) damp(tracks[key], targets[key], 3.7, 1 / hz);
    presentation.update(1 / hz, true, musicArchiveTracksSettled(tracks, targets), false);
  }
  assert.equal(presentation.phase, 'archive', 'Readiness returns after all selected-cell tracks settle');
  for (const key of Object.keys(tracks)) {
    const speed = tracks[key].velocity;
    tracks[key].velocity = .1;
    assert.equal(musicArchiveTracksSettled(tracks, targets), false, `${key} velocity must settle too`);
    tracks[key].velocity = speed;
  }
}
// The lens of each view (MUSIC_LENS): the shelf and the song scene use the depth of field to set the selection apart.
const radians = Math.PI / 180;
{
  const film = musicLens(0, 0, 0), opened = musicLens(0, 1, 0), shelf = musicLens(1, 0, 0), song = musicLens(0, 1, 1);
  assert.deepEqual(film, { aperture: MUSIC_LENS.archive.shelf, range: 0, lean: 0 }, 'The opening film keeps the archive lens');
  assert.deepEqual(opened, { aperture: MUSIC_LENS.archive.detail, range: 0, lean: 0 }, 'The opened album keeps its lens, with no in-focus slab');
  assert.equal(MUSIC_LENS.archive.shelf, 0.0003);
  assert.equal(MUSIC_LENS.archive.detail, 0.0008);
  assert.deepEqual(shelf, { aperture: MUSIC_LENS.shelf.aperture, range: MUSIC_LENS.shelf.range, lean: 1 }, 'The settled shelf measures the defocus on the shelf');
  assert.deepEqual(song, { aperture: MUSIC_LENS.song.aperture, range: MUSIC_LENS.song.range, lean: 0 }, 'The song scene measures it along the lens');
  assert.deepEqual(musicLens(1, 0, 1), { aperture: MUSIC_LENS.song.aperture, range: MUSIC_LENS.song.range, lean: 0 }, 'The song scene decides once it is shown');
  // Every way between the views is even: no value leaves the range of its two ends.
  const between = (value, from, to) => value >= Math.min(from, to) - 1e-12 && value <= Math.max(from, to) + 1e-12;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const settling = musicLens(t, 0, 0), opening = musicLens(1 - t, t, 0), entering = musicLens(0, 1, t), direct = musicLens(1 - t, t, t);
    assert.ok(between(settling.aperture, film.aperture, shelf.aperture) && between(settling.lean, 0, 1) && between(settling.range, 0, shelf.range), 'the opening settles into the shelf lens');
    assert.ok(between(opening.aperture, opened.aperture, shelf.aperture) && between(opening.range, 0, shelf.range), 'opening an album');
    assert.ok(between(entering.aperture, opened.aperture, song.aperture) && entering.lean === 0 && between(entering.range, 0, song.range), 'detail to song scene');
    assert.ok(between(direct.aperture, Math.min(opened.aperture, shelf.aperture), Math.max(shelf.aperture, song.aperture)) && between(direct.lean, 0, 1) && between(direct.range, 0, song.range), 'shelf straight to the song scene');
  }
}
{
  // Blur radius in pixels, as the shader computes it: its outermost tap is 0.4 of the blur
  // vector, which is in units of the picture's WIDTH; `defocus` is what the focus term measures.
  const blur = (defocus, aperture, range, width = 1920, maxblur = 0.011) => 0.4 * width * Math.min(maxblur, Math.max(0, Math.abs(defocus) - range) * aperture);
  const limit = 0.4 * 1920 * 0.011;
  // Song scene: along the lens. The large card is turned to it by the view's yaw; the packed depth is rounded by up to 0.3 there.
  const half = MUSIC_MODEL.width / 2;
  assert.ok(half * Math.sin(SONG_VIEW.yaw * radians) + 0.3 < MUSIC_LENS.song.range, 'The large card and the depth rounding fit inside the song scene\'s in-focus slab');
  const chain = (u) => blur(songChainPose(u).z, MUSIC_LENS.song.aperture, MUSIC_LENS.song.range);
  assert.ok(chain(SONG_CHAIN_CENTRE + 1) > 1 && chain(SONG_CHAIN_CENTRE - 1) > 0.5, `The chain's places next to the selection are already soft (${chain(SONG_CHAIN_CENTRE + 1).toFixed(1)} / ${chain(SONG_CHAIN_CENTRE - 1).toFixed(1)} px)`);
  for (let u = 0; u < 13; u++) assert.ok(chain(u + 1) > chain(u), `and each place further along is softer (${u})`);
  assert.ok(chain(13) > 4 && chain(13) < limit, `up to a clear blur that is still below the lens's limit (${chain(13).toFixed(1)} px)`);
  assert.equal(blur(0.31, MUSIC_LENS.song.aperture, MUSIC_LENS.song.range), 0, 'while the large card\'s own edges are not blurred at all');
  // Shelf: on the shelf itself. The selected case is 0.28 thick along the rows and stays sharp
  // from edge to edge whatever the camera's angle; its row neighbours soften one by one.
  const row = (rows, lanes = 0) => blur(Math.hypot(rows * ROW_SPACING, lanes * COLUMN_SPACING * MUSIC_LENS.shelf.lane), MUSIC_LENS.shelf.aperture, MUSIC_LENS.shelf.range);
  assert.ok(MUSIC_MODEL.depth / 2 < MUSIC_LENS.shelf.range && MUSIC_LENS.shelf.range < ROW_SPACING, 'The slab holds the selected case and none of its neighbours');
  assert.equal(row(0), 0);
  assert.ok(row(1) > 0.3 && row(1) < 1, `The next row is just soft (${row(1).toFixed(2)} px)`);
  for (let rows = 0; rows < 12; rows++) assert.ok(row(rows + 1) > row(rows) || row(rows) === limit, `each row is softer than the one before (${rows})`);
  assert.ok(row(4) > 2.5 && row(8) > 6, `a few rows away the blur is clear (${row(4).toFixed(1)} px at 4, ${row(8).toFixed(1)} px at 8)`);
  assert.ok(row(0, 1) > row(1) && row(0, 1) < row(3), `a neighbouring lane counts as about two rows (${row(0, 1).toFixed(2)} px)`);
  // Against the archive lens along the lens axis: neighbouring rows are 0.29 units of lens depth apart there
  // (the camera looks along them at 59 degrees, 25 degrees down), so four rows were under a pixel.
  const along = (rows) => blur(rows * ROW_SPACING * Math.cos(59 * radians) * Math.cos(25 * radians), MUSIC_LENS.archive.shelf, 0);
  assert.ok(along(4) < 0.4 && row(4) > 6 * along(4), `the lens-axis focus could not set the selection apart (${along(4).toFixed(2)} px at 4 rows)`);
}
{
  // The stock shader gets its uniforms and one block after its focus term; an unknown shader is refused.
  const patched = focalShader(BokehShader.fragmentShader);
  for (const uniform of ['float focalRange', 'float focalLean', 'vec2 focalSlope', 'vec3 focalPoint', 'vec3 focalRow', 'vec3 focalLane'])
    assert.equal(patched.split(`uniform ${uniform};`).length, 2, uniform);
  const focus = patched.indexOf('float factor = ( focus + viewZ );'), lean = patched.indexOf('if ( focalLean > 0.0 )'),
    slab = patched.indexOf('factor = sign( factor ) * max( abs( factor ) - focalRange, 0.0 );'), radius = patched.indexOf('clamp( factor * aperture');
  assert.ok(focus > 0 && focus < lean && lean < slab && slab < radius, 'The shelf focus and the slab are applied before the blur radius is computed');
  assert.ok(patched.includes('vec3( ( vUv * 2.0 - 1.0 ) * focalSlope * -viewZ, viewZ ) - focalPoint'), 'The pixel is placed in view space from its depth');
  assert.throws(() => focalShader('void main() {}'), /bokeh shader/);
  // The shelf term in numbers: a point `rows` rows and `lanes` lanes from the focus, seen by a camera turned
  // 59 degrees from the row axis and 25 degrees down, measures the same on the shelf whatever the camera.
  const camera = new THREE.PerspectiveCamera(6, 16 / 9, 5, 300);
  camera.position.set(Math.sin(59 * radians) * Math.cos(25 * radians), Math.sin(25 * radians), Math.cos(59 * radians) * Math.cos(25 * radians)).multiplyScalar(140);
  camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true); camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  const rowAxis = new THREE.Vector3(0, 0, 1).transformDirection(camera.matrixWorldInverse);
  const laneAxis = new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorldInverse).multiplyScalar(MUSIC_LENS.shelf.lane);
  const focusView = new THREE.Vector3(0, 2, 0).applyMatrix4(camera.matrixWorldInverse);
  for (const [rows, lanes, height] of [[0, 0, 1.2], [1, 0, 0], [-3, 0, 0.9], [0, 1, 0], [5, -2, 0]]) {
    const from = new THREE.Vector3(lanes * COLUMN_SPACING, 2 + height, rows * ROW_SPACING).applyMatrix4(camera.matrixWorldInverse).sub(focusView);
    const measured = Math.hypot(from.dot(rowAxis), from.dot(laneAxis));
    assert.ok(Math.abs(measured - Math.hypot(rows * ROW_SPACING, lanes * COLUMN_SPACING * MUSIC_LENS.shelf.lane)) < 1e-9, `rows ${rows}, lanes ${lanes}: the height above the shelf does not count`);
  }
}
console.log('Music camera passed: continuous motion, frame-rate independence, original-film oblique pause/frontal ending, shared entry/return gates, elevated detail, interruption, replay and reduced motion.');
console.log(`Presentation pan: ${(pan240.early * 100).toFixed(3)}% at 0.2 s; 95% at ${pan240.t95.toFixed(3)} s (rendered camera, 240 Hz).`);
