import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MusicCameraMotion, MusicPlacementMotion, MusicPresentation, musicArchiveTracksSettled, musicCinematicPose, musicExtractionAnchor,
  MUSIC_LENS, musicLens } from '../src/music-camera.ts';
import { damp } from '../src/motion.ts';
import { BokehShader } from 'three/addons/shaders/BokehShader.js';
import { FOCAL_GUARD, FOCAL_NO_BOX, focalBoxes, focalFootprint, focalGuardWeight, focalShader } from '../src/depth-of-field.ts';
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
  // The guard: its uniforms, and a guarded copy of the gather beside the stock one, which the
  // shelf, the opened album and the opening film keep (the guard is 0 there), and so does every
  // pixel whose blur reaches no box or that does not blur at all.
  assert.equal(patched.split('uniform float focalGuard;').length, 2, 'float focalGuard');
  assert.equal(patched.split(`uniform vec4 focalBoxes[ ${FOCAL_GUARD.boxes} ];`).length, 2, 'vec4 focalBoxes: the boxes on screen of the cases that are the large card, the only places it guards');
  assert.equal(patched.split(`uniform float focalBoxWeights[ ${FOCAL_GUARD.boxes} ];`).length, 2, 'float focalBoxWeights: how much each of them is the card');
  const stockGather = BokehShader.fragmentShader.slice(BokehShader.fragmentShader.indexOf('vec4 col = vec4( 0.0 );') + 'vec4 col = vec4( 0.0 );'.length,
    BokehShader.fragmentShader.indexOf('gl_FragColor = col / 41.0;'));
  assert.ok(patched.includes(`} else {\n${stockGather}\n\t}`), 'The stock gather is kept as it is');
  assert.ok(patched.includes('if ( focalGuard > 0.0 && dofblur.x != 0.0 && focalBoxed( vUv, 0.4 * abs( dofblur ) * aspectcorrect ) > 0.0 ) {'),
    'and runs wherever the guard is off, nothing blurs or the blur reaches no box');
  const ring = [...stockGather.matchAll(/col \+= texture2D\( tColor, ([^\n;]+) \);/g)].map((tap) => tap[1].trim()).filter((uv) => uv !== 'vUv.xy');
  assert.equal(ring.length, 40, 'The stock gather is the pixel\'s own sample and 40 around it');
  assert.ok(patched.includes(`\t\tcol += texture2D( tColor, vUv.xy );\n\t\ttotal = 1.0;\n\t\tvec2 focalTaps[ 40 ] = vec2[ 40 ](\n\t\t\t${ring.join(',\n\t\t\t')} );\n\t\tfor ( int i = 0; i < 40; i++ ) focalTap( focalTaps[ i ], centre, col, total );`),
    'The guarded copy counts the pixel\'s own sample as it is and loops over the others in the stock order (a small shader: compiled sample by sample it took seconds)');
  assert.ok(patched.includes('col += weight * textureLod( tColor, uv, 0.0 );'), 'reading their colours as texture2D does here, at level 0');
  assert.ok(patched.indexOf('float getDepth(') < patched.indexOf('float focalHides(') && patched.indexOf('float focalHides(') < patched.indexOf('void main()'),
    'The guard reads the depth the way the shader does');
  assert.ok(patched.includes('ivec2 first = ivec2( floor( uv * vec2( textureSize( tDepth, 0 ) ) - 0.5 ) ) - 1;') &&
    patched.includes('for ( int y = 0; y < 4; y++ )\n\t\tfor ( int x = 0; x < 4; x++ )\n\t\t\thides = max( hides, focalCard( first + ivec2( x, y ), centre ) );'),
    'and reads a sample\'s whole footprint (focalFootprint)');
  assert.throws(() => focalShader(BokehShader.fragmentShader.replace(/\n\s*col \+= texture2D\( tColor, [^\n]*/, '')), /41-sample gather/,
    'a gather of another size is refused');
  assert.throws(() => focalShader(BokehShader.fragmentShader.replace('col += texture2D( tColor, vUv.xy );', 'col += texture2D( tColor, vUv.xy + vec2( 0.0 ) );')), /41-sample gather/,
    'and so is one without the pixel\'s own sample');
  // In numbers, in the song scene (the focus is on the large card, the depth rounded by up to
  // 0.3 either way). The large card is sharp from corner to corner: turned by the view's yaw
  // and seen from its elevation, it is at most this far from the focus along the lens.
  const lens = SONG_VIEW.distance, range = MUSIC_LENS.song.range, rounding = 0.3, half = MUSIC_MODEL.width / 2;
  const corner = half * Math.sin(SONG_VIEW.yaw * radians) + MUSIC_MODEL.height / 2 * Math.sin(SONG_VIEW.elevation * radians) + MUSIC_MODEL.depth / 2;
  for (const offset of [-corner - rounding, 0, corner + rounding]) {
    const tap = lens + offset;
    assert.equal(focalGuardWeight(tap + FOCAL_GUARD.nearer[1], tap, lens, range), 0, `the card ${offset.toFixed(2)} from the focus is left out of what lies behind it`);
    assert.equal(focalGuardWeight(300, tap, lens, range), 0, 'and out of the far background');
    assert.equal(focalGuardWeight(tap, tap, lens, range), 1, 'while it still counts for itself');
    assert.equal(focalGuardWeight(300, tap, lens, range, 0), 1, 'and every sample counts with the guard off');
  }
  // The chain's places past the lifted case's own are blurred, their nearest corner (turned
  // 28 degrees, song-pose.ts YAW) included: their colours still blur into the places behind
  // them and into the background, as they did before the guard.
  for (let u = SONG_CHAIN_CENTRE + 1; u < 14; u++) {
    const pose = songChainPose(u);
    const nearest = pose.z + (Math.sin(28 * radians) * half + MUSIC_MODEL.depth / 2) * pose.scale + rounding;
    assert.equal(focalGuardWeight(300, lens - nearest, lens, range), 1, `place ${u} still blurs into the background`);
    assert.equal(focalGuardWeight(lens - songChainPose(u + 1).z, lens - nearest, lens, range), 1, `and into place ${u + 1}`);
  }
  // The footprint, drawn out: the card's outline (an edge at any angle, or a corner) over a dark
  // background, as the scene pass draws it (eight samples a texel, in Direct3D's pattern) with
  // its depth taken once at each texel's centre; the pixels around it blur with the stock gather.
  // Read at the sample alone, the depth let the outline's colour into the blur (the thin lines
  // around the card); read over the whole footprint, none of it comes in.
  const offsets = [...stockGather.matchAll(/vUv\.xy \+ \( vec2\(\s*([-\d.]+),\s*([-\d.]+)\s*\) \* aspectcorrect \) \* dofblur(\d?)/g)]
    .map(([, x, y, ring]) => [+x * (ring ? +ring / 10 : 1), +y * (ring ? +ring / 10 : 1)]);
  assert.equal(offsets.length, 40);
  assert.ok(offsets.every(([x, y]) => Math.abs(x) <= 0.4 && Math.abs(y) <= 0.4), 'Every sample lies within 0.4 of the blur either way');
  for (const u of [3, 3.2, 3.5, 3.51, 3.9, 4.49]) {
    const [first, last] = focalFootprint(u), read = Math.floor(u - 0.5);
    assert.ok(first === read - 1 && last === read + 2, `the footprint of a read at ${u}: the two texels it blends and one more either side`);
  }
  const multisamples = [[1, -3], [-1, 3], [5, 1], [-3, -5], [-5, 5], [-7, -1], [3, 7], [7, -7]].map(([x, y]) => [x / 16, y / 16]);
  const size = 40, centre = 20;
  let leakAlone = 0, leakFootprint = 0;
  for (const angle of [0, 7, 20, 33, 45, 61, 90])
    for (const shift of [0, 0.23, 0.5, 0.81])
      for (const corner of [false, true]) {
        const a = angle * radians, inside = (x, y) => {
          const dx = x - centre - shift, dy = y - centre - shift / 3;
          return dx * Math.cos(a) + dy * Math.sin(a) < 0 && (!corner || -dx * Math.sin(a) + dy * Math.cos(a) < 0);
        };
        const clampTexel = (i) => Math.min(size - 1, Math.max(0, i));
        const card = (i, j) => inside(clampTexel(i) + 0.5, clampTexel(j) + 0.5);
        const cover = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) =>
          multisamples.filter(([x, y]) => inside(i + 0.5 + x, j + 0.5 + y)).length / multisamples.length));
        const colour = (x, y) => {
          const i = Math.floor(x - 0.5), j = Math.floor(y - 0.5), fx = x - 0.5 - i, fy = y - 0.5 - j, c = (p, q) => cover[clampTexel(p)][clampTexel(q)];
          return (1 - fx) * (1 - fy) * c(i, j) + fx * (1 - fy) * c(i + 1, j) + (1 - fx) * fy * c(i, j + 1) + fx * fy * c(i + 1, j + 1);
        };
        const footprint = (x, y) => {
          const [i0, i1] = focalFootprint(x), [j0, j1] = focalFootprint(y);
          for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (card(i, j)) return true;
          return false;
        };
        for (let i = 8; i < size - 8; i++)
          for (let j = 8; j < size - 8; j++) {
            // A pixel behind the card's outline: not the card, none of its colour, and no card
            // beside it (those keep their own colour).
            if (cover[i][j] > 0 || card(i, j) || card(i + 1, j) || card(i - 1, j) || card(i, j + 1) || card(i, j - 1)) continue;
            for (const blur of [2, 5, 11, 15]) {
              let alone = 0, aloneCount = 1, guarded = 0, guardedCount = 1;
              for (const [dx, dy] of offsets) {
                const x = i + 0.5 + dx * blur, y = j + 0.5 + dy * blur, c = colour(x, y);
                if (!card(Math.floor(x), Math.floor(y))) { alone += c; aloneCount++; }
                if (!footprint(x, y)) { guarded += c; guardedCount++; }
              }
              leakAlone = Math.max(leakAlone, alone / aloneCount);
              leakFootprint = Math.max(leakFootprint, guarded / guardedCount);
            }
          }
      }
  assert.ok(leakAlone > 0.05, `read at the sample alone, the outline came into the blur (${(leakAlone * 100).toFixed(1)} % of the card's colour)`);
  assert.equal(leakFootprint, 0, 'read over the footprint, none of it does');
}
{
  // The guard's boxes: the large card's, and on a step those of the copy leaving its place and of
  // the case rising into it, each as much as it is the large card; empty ones hold nothing.
  const width = 1440, height = 900, card = (share, left, top) => ({ share, left, top, right: left + 340, bottom: top + 260 });
  const uv = ({ left, top, right, bottom }) => [left / width, 1 - bottom / height, right / width, 1 - top / height];
  const empty = { box: [...FOCAL_NO_BOX], weight: 0 };
  const reach = FOCAL_GUARD.reach / 320;
  assert.ok(FOCAL_NO_BOX[0] - reach > 1 && FOCAL_NO_BOX[1] - reach > 1 && FOCAL_NO_BOX[2] + reach < 0 && FOCAL_NO_BOX[3] + reach < 0,
    'An empty box reaches no point of the picture, even in a picture 320 texels wide');
  const large = card(1, 285, 328);
  assert.deepEqual(focalBoxes([large], width, height), [{ box: uv(large), weight: 1 }, empty, empty, empty], 'At rest: the large card');
  const rising = card(0.15, 300, 560);
  assert.deepEqual(focalBoxes([rising, large], width, height), [{ box: uv(large), weight: 1 }, { box: uv(rising), weight: 0.15 }, empty, empty],
    'On a step: the copy leaving the card\'s place, still the large card, and the case rising into it');
  assert.deepEqual(focalBoxes([card(0, 300, 560), large], width, height)[1], empty, 'A case that is not the card at all has no box');
  const burst = [0.9, 0.3, 0.7, 0.1, 0.5].map((share, k) => card(share, 100 * k, 40 * k));
  const boxes = focalBoxes(burst, width, height);
  assert.deepEqual(boxes.map((b) => b.weight), [0.9, 0.7, 0.5, 0.3], 'A burst of steps: the cards that are the card most first');
  assert.deepEqual(boxes[3].box, [100 / width, 1 - 380 / height, 640 / width, 1 - 40 / height], 'and the last box takes in all that are left');
}
{
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
