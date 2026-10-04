import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { COLUMN_SPACING, ROW_SPACING, LOOP_COLUMNS, LOOP_ROWS, visibleCell } from '../src/archive-loop.ts';
import { MUSIC_MODEL, isMusicShellSurface, createAlbumPrintMaterial } from '../src/music-model.ts';
import { MusicSelectionLighting, SELECTION_FIELD, SELECTION_GAIN, SELECTION_POOL_TINT, SELECTION_SONG_SHADE, selectionPool, selectionRaised, selectionReach, selectionRow, selectionSongShade } from '../src/music-lighting.ts';
import { damp, settlingWave } from '../src/motion.ts';
import { songLiftHold } from '../src/song-pose.ts';
function setup() {
  const light = new MusicSelectionLighting(new THREE.Scene());
  const model = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(); camera.position.set(-62,36,43); camera.lookAt(0,0,0);
  light.update(model,camera,0,true,true);
  const shader = {uniforms:{},vertexShader:'#include <begin_vertex>',fragmentShader:'#include <opaque_fragment>'};
  light.shade(shader,'Frosted_Polymer');
  return {light,model,camera,shader,column:shader.uniforms.musicLightColumn.value};
}
const a=setup(), b=setup();
a.model.position.x=b.model.position.x=5.2;
a.light.update(a.model,a.camera,.1,true,false);
assert.ok(a.column.x>0 && a.column.x<.5,'Light begins gradually with the lift');
for(let i=0;i<12;i++)b.light.update(b.model,b.camera,1/120,true,false);
assert.ok(a.column.distanceTo(b.column)<1e-9,'Light transition is independent of frame rate');
assert.ok(Math.abs(a.light.focus-b.light.focus)<1e-9,'Emphasis thinning is independent of frame rate');
assert.ok(a.light.focus>.3 && a.light.focus<.8,'A lane move thins the shelf emphasis while the light travels');
const before=a.column.clone();
a.model.position.x=-5.2;
a.light.update(a.model,a.camera,1/60,true,false);
assert.ok(a.column.distanceTo(before)<.2,'Rapid reversal preserves position and velocity continuity');
a.light.update(a.model,a.camera,0,true,true);
assert.equal(a.column.x,-5.2,'Reduced motion snaps to the selected location');
assert.equal(a.light.focus,1,'Reduced motion shows the whole shelf emphasis at once');
// Use the actual shell bounds and complete instance pool, including its hidden
// margins. A source inside this volume can burn a corner even when the selected
// CD itself has the desired exposure; checking only source-to-target misses it.
const glb = fs.readFileSync(new URL('../public/assets/music-case.glb', import.meta.url));
const asset = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
// The glass shell: the index inlay and screws stand slightly proud of it.
const shellBounds = new THREE.Box3();
asset.scene.traverse(object => { if (object instanceof THREE.Mesh && isMusicShellSurface(object.material.name.replace(/\.\d+$/, ''))) shellBounds.expandByObject(object); });
const shaderBounds = a.shader.uniforms.musicShellBounds.value;
assert.ok(Math.abs(shaderBounds.x-shellBounds.min.x)<1e-6,'Warm spine begins at the actual transformed left glass edge');
assert.ok(Math.abs(shaderBounds.y-shellBounds.min.y)<1e-6,'Height falloff begins at the inset bottom edge');
assert.ok(Math.abs(shaderBounds.z-shellBounds.max.y)<1e-6,'Top ribbon peaks at the actual transformed top edge');
assert.ok(Math.abs(1/shaderBounds.w-shellBounds.getSize(new THREE.Vector3()).y)<1e-6,'Light height follows the shortened glass panel');
const falloff = a.shader.uniforms.musicEdgeFalloff.value;
assert.ok(Math.log(2)/falloff.y<0.035,'Top ribbon half-brightness width stays below 0.035 model units');
assert.ok(Math.exp(-MUSIC_MODEL.width*falloff.x)<0.001,'Warm spine transport decays before crossing the entire panel');
assert.ok(a.shader.fragmentShader.includes('vMusicLocal.x - musicShellBounds.x') && a.shader.fragmentShader.includes('musicShellBounds.z - vMusicLocal.y'),'The material shader consumes the geometry bounds for both highlighted edges');
const localAim = a.light.spot.target.position.clone().sub(a.model.position);
assert.ok(localAim.x>shellBounds.min.x && localAim.x<shellBounds.min.x+0.3,'Spot target tracks the thin left glass frame');
assert.ok(localAim.y>shellBounds.min.y && localAim.y<shellBounds.max.y,'Spot target remains inside the actual case height');
// Prints receive diffuse light through their own path, never the shell glow.
const print = createAlbumPrintMaterial(new THREE.Texture());
const printShader = { uniforms: {...THREE.ShaderLib.lambert.uniforms}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
const beforePrint = { uniforms: {...printShader.uniforms}, vertexShader: printShader.vertexShader, fragmentShader: printShader.fragmentShader };
a.light.shade(printShader,'Album_Print');
assert.deepEqual(printShader,beforePrint,'Album artwork receives no glow, tint, transmission or shell-light shader injection');
assert.equal(print.isMeshLambertMaterial,true,'Printed artwork receives diffuse illumination');
assert.equal(print.emissive.getHex(),0,'Printed artwork has no emissive floor');
assert.equal(print.toneMapped,false,'Artwork adds no separate exposure response');
assert.equal(print.fog,true,'Distant prints recede with the archive atmosphere');
a.light.shadePrint(printShader);
assert.equal(printShader.uniforms.musicPrintLightColumn,a.shader.uniforms.musicLightColumn,'Covers follow the same continuous light position as the shell');
assert.ok(printShader.vertexShader.includes('instanceMatrix * musicPrintOrigin'),'Instanced and extracted covers evaluate light in the same world coordinates');
assert.ok(printShader.fragmentShader.includes('outgoingLight *= mix(musicPrintAmbient, 1.0, printLight)'),'The print field only attenuates real diffuse illumination');

// Shelf emphasis: a tinted shadow pool on the rows in front of the selection, a lit
// band along its row and a rim on the raised case. Offsets are (lane, row) from the
// light column. The rows on the shelf (instances) always rest; only the lifted case and
// returning copies (plain meshes) are raised, by their height from the column.
const browsingLift = 0.9;
for (const rows of [0, -1, -3, -8]) assert.equal(selectionPool(0, rows * ROW_SPACING), 0, 'The selected row and the rows behind it stay out of the shadow pool');
assert.equal(selectionRaised(-browsingLift), 0, 'A copy back at shelf level, the browsing lift below the selection, no longer counts as raised');
assert.equal(selectionRaised(0), 1, 'A case as high as the lit selection counts as raised');
for (const rows of [1, 4, 12]) assert.equal(selectionPool(0, rows * ROW_SPACING, selectionRaised(0)), 0, 'A raised case is never shaded');
for (let rows = 2; rows <= 8; rows++) assert.ok(selectionPool(0, rows * ROW_SPACING) >= 0.95, 'The pool holds its full depth over rows +2 to +8');
const firstRow = selectionPool(0, ROW_SPACING);
assert.ok(firstRow > 0.6 && firstRow < 0.9, 'The first row in front is already most of the way into the pool');
assert.ok(selectionPool(0, 17 * ROW_SPACING) <= 0.01, 'The pool has gone by row +17');
for (const side of [-2, 2]) assert.ok(selectionPool(side * COLUMN_SPACING, 4 * ROW_SPACING) <= 0.01, 'The pool has gone two lanes away');
for (const side of [-1, 1]) {
  const beside = selectionPool(side * COLUMN_SPACING, 4 * ROW_SPACING);
  assert.ok(beside > 0.5 && beside < 0.8, 'Both neighboring lanes lie in a lighter part of the pool');
}
assert.equal(selectionRow(0), 1, 'The band is centred on the selected row');
assert.ok(selectionRow(ROW_SPACING) > 0.2 && selectionRow(ROW_SPACING) < 0.35, 'The band spills softly onto one row towards the camera');
assert.ok(selectionRow(-ROW_SPACING) < 0.1 && selectionRow(2 * ROW_SPACING) < 0.02, 'The band stays one row wide');
assert.equal(selectionReach(0), 1);
assert.equal(selectionReach(-1.5 * COLUMN_SPACING), 1, 'The band runs 1.5 lanes towards -X at full strength');
assert.equal(selectionReach(-3 * COLUMN_SPACING), 0, 'The band ends before the third lane');
assert.ok(selectionReach(COLUMN_SPACING) > 0.4 && selectionReach(COLUMN_SPACING) < 0.8 && selectionReach(2 * COLUMN_SPACING) === 0, 'The band is short towards +X');
for (const tint of Object.values(SELECTION_POOL_TINT)) assert.ok(tint.every(channel => channel > 0.5 && channel <= 1), 'The pool tint only removes light, and never most of it');
assert.ok(SELECTION_POOL_TINT.day[0] > SELECTION_POOL_TINT.day[1] && SELECTION_POOL_TINT.day[1] > SELECTION_POOL_TINT.day[2], 'The day pool is a warm shade');
assert.ok(SELECTION_POOL_TINT.night[2] > SELECTION_POOL_TINT.night[1] && SELECTION_POOL_TINT.night[1] > SELECTION_POOL_TINT.night[0], 'The night pool is a cool shade');
// The shader text is generated from the same constants the functions above use.
const fixed = value => value.toFixed(3);
assert.ok(a.shader.vertexShader.includes(`smoothstep(${fixed(SELECTION_FIELD.poolNear[0])}, ${fixed(SELECTION_FIELD.poolNear[1])}, delta.z)`) &&
  a.shader.vertexShader.includes(`smoothstep(${fixed(SELECTION_FIELD.poolFar[0])}, ${fixed(SELECTION_FIELD.poolFar[1])}, delta.z)`) &&
  a.shader.fragmentShader.includes(`smoothstep(${fixed(SELECTION_FIELD.reachLeft[0])}, ${fixed(SELECTION_FIELD.reachLeft[1])}, -musicAlong)`), 'Shell shader and checks share one set of field constants');
assert.deepEqual(a.shader.uniforms.musicRibbonGain.value.toArray(), [...SELECTION_GAIN], 'The calibrated gains reach the shell shader');
// The shelf's share (musicFocus) scales the band, the rim and the pool; the song scene's share
// (musicSong) keeps the rim on the large card (musicCard, the case's own share of it) and lays
// every other case in the pool's shade.
const songShade = `(1.0 - musicCard) * musicSong * ${fixed(SELECTION_SONG_SHADE)}`;
assert.ok(/float musicRow = [^;]*\* musicFocus;/.test(a.shader.fragmentShader) &&
  /float musicRim = [^;]*\* max\(vMusicField\.z \* vMusicField\.y \* exp\(-musicNear \* musicNear\) \* musicFocus, musicCard \* musicSong\);/.test(a.shader.fragmentShader) &&
  a.shader.fragmentShader.includes(`outgoingLight *= mix(vec3(1.0), musicPoolTint, max(vMusicField.x * musicFocus, ${songShade}))`), 'Band, rim and pool vanish when neither the shelf nor the song scene is shown');
assert.ok(!/musicRow = [^;]*musicSong/.test(a.shader.fragmentShader), 'The band along the shelf row belongs to the shelf alone');
assert.ok(!/vMusicField\.z\) \* musicSong|vMusicField\.z \* musicSong/.test(a.shader.fragmentShader), 'The song scene never reads a case\'s height against the light column');
assert.equal(a.shader.uniforms.musicCard.value, 0, 'A shelf program is never the large card');
assert.equal(a.shader.uniforms.musicCard, b.shader.uniforms.musicCard);
{ const card = { value: 0.25 }, own = {uniforms:{},vertexShader:'#include <begin_vertex>',fragmentShader:'#include <opaque_fragment>'};
  a.light.shade(own,'Frosted_Polymer',card);
  assert.equal(own.uniforms.musicCard, card, 'The lifted case and each copy carry their own share of the large card');
  assert.equal(own.fragmentShader, a.shader.fragmentShader, 'in the same program text'); }
const hardware = {uniforms:{},vertexShader:'#include <begin_vertex>',fragmentShader:'#include <opaque_fragment>'};
a.light.shade(hardware,'Titanium_Fasteners');
assert.ok(hardware.fragmentShader.includes('musicPoolTint') && !hardware.fragmentShader.includes('musicRim'), 'Hardware lies in the same pool but carries no glass rim');
assert.equal(printShader.uniforms.musicPoolTint, a.shader.uniforms.musicPoolTint, 'Covers and shells share one pool tint');
assert.equal(printShader.uniforms.musicFocus, a.shader.uniforms.musicFocus, 'Covers and shells share one focus');
assert.equal(printShader.uniforms.musicSong, a.shader.uniforms.musicSong, 'Covers and shells share one song-scene share');
assert.ok(printShader.vertexShader.includes('vMusicPrintPool = musicSelectionField(vMusicPrintOrigin - musicPrintLightColumn).x'), 'Covers evaluate the same pool as their shell');
assert.ok(printShader.fragmentShader.includes(`outgoingLight *= mix(vec3(1.0), musicPoolTint, max(vMusicPrintPool * musicFocus, ${songShade}))`), 'The pool, or the song scene\'s shade, multiplies the print');
assert.equal(printShader.uniforms.musicCard.value, 0, 'A print without its own share is a chain print');
{ const card = { value: 1 }, lifted = {uniforms:{},vertexShader:'#include <begin_vertex>',fragmentShader:'#include <opaque_fragment>'};
  a.light.shadePrint(lifted, card);
  assert.equal(lifted.uniforms.musicCard, card, 'The lifted print carries its case\'s share of the large card'); }
assert.ok(!printShader.fragmentShader.includes('+='), 'Nothing is ever added to the print');
// Shelf instances are never raised. three.js defines USE_INSTANCING for them and leaves it
// undefined for the lifted case and returning copies, which keep the height test.
const instancedBranch = /#ifdef USE_INSTANCING\s+float raised = 0\.0;\s+#else\s+float raised = smoothstep\(/;
assert.ok(instancedBranch.test(a.shader.vertexShader), 'Shelf instances are never raised in the shell shader');
assert.ok(instancedBranch.test(printShader.vertexShader), 'Shelf instances are never raised in the print shader');
// The generated field function itself, evaluated as written for either kind of mesh:
// [pool, row weight, raised] at an offset (dx, dy, dz) from the light column.
const shaderField = (vertexShader, instanced) => {
  const body = /vec3 musicSelectionField\(vec3 delta\)\s*\{([^{}]*)\}/.exec(vertexShader)[1]
    .replace(/#ifdef USE_INSTANCING([^#]*)#else([^#]*)#endif/, instanced ? '$1' : '$2')
    .replace(/\bfloat /g, 'let ').replace(/return vec3\(([^;]*)\);/, 'return [$1];');
  assert.ok(!body.includes('#') && body.includes('return ['), 'The field function is plain arithmetic around one instancing branch');
  const evaluate = new Function('delta', 'smoothstep', 'exp', body);
  return (x, y, z) => evaluate({x, y, z}, (from, to, value) => THREE.MathUtils.smoothstep(value, from, to), Math.exp);
};
const fields = [a.shader.vertexShader, printShader.vertexShader].map(vertexShader => [shaderField(vertexShader, true), shaderField(vertexShader, false)]);
const [shelfField, liftedField] = fields[0];
const same = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, message);
for (const [instanced, plain] of fields) for (const dx of [0, -COLUMN_SPACING, 2.6]) for (const dy of [0.4, 0, -0.3, -0.6, -browsingLift, -2]) for (const dz of [-3, -1, 0, 1, 4, 12].map(rows => rows * ROW_SPACING)) {
  const shelf = instanced(dx, dy, dz), lifted = plain(dx, dy, dz);
  assert.equal(shelf[2], 0, 'A shelf instance is not raised at any height from the column');
  same(shelf[0], selectionPool(dx, dz), 'The pool on a shelf instance depends on lane and row alone');
  same(lifted[2], selectionRaised(dy), 'The lifted case and returning copies are raised by their height from the column');
  same(lifted[0], selectionPool(dx, dz, selectionRaised(dy)), 'A raised case leaves the pool');
  same(shelf[1], selectionRow(dz), 'Shader and checks share one lit-row weight'); same(lifted[1], selectionRow(dz), 'Shader and checks share one lit-row weight');
}
// A selection change drops the lift to 0 and the light column follows the new case down to
// shelf level (scene.select() and the lift, shoulder and rail springs). The rows resting on
// the shelf must keep their shade meanwhile: the pool by depth alone and no rim.
const stepping = (reduced, direction, presses, interval) => {
  const s = setup(), dt = 1 / 60;
  const shoulder = {value:0,velocity:0}, rail = {value:0,velocity:0}, lift = {value:browsingLift,velocity:0};
  const copies = new Map();
  let selected = 0;
  const base = row => settlingWave(row - shoulder.value, 26.56);
  const place = () => s.model.position.set(0, base(selected) + lift.value, selected * ROW_SPACING + rail.value);
  place(); s.light.update(s.model, s.camera, 0, true, true);
  const worst = {rim:0, poolLost:0, byHeight:0, column:Infinity};
  for (let frame = 0; frame < presses * interval + 120; frame++) {
    if (frame % interval === 0 && frame < presses * interval) {
      // A case that has risen leaves a returning copy in its cell; one that barely rose just drops.
      if (lift.value >= 0.12) copies.set(selected, {...lift});
      lift.value = lift.velocity = 0;
      selected += direction;
      if (copies.has(selected)) { Object.assign(lift, copies.get(selected)); copies.delete(selected); }
    }
    damp(shoulder, selected, reduced ? 35 : 5, dt);
    damp(rail, -selected * ROW_SPACING, reduced ? 35 : 3.7, dt);
    damp(lift, browsingLift, reduced ? 35 : 4.2, dt);
    for (const [row, copy] of copies) { damp(copy, 0, reduced ? 35 : 4.5, dt); if (copy.value < 0.0001) copies.delete(row); }
    place();
    s.light.update(s.model, s.camera, dt, true, reduced, false, 1, 0, rail.velocity);
    worst.column = Math.min(worst.column, s.column.y - base(selected));
    for (let ahead = 1; ahead <= 8; ahead++) {
      const row = selected + ahead;
      // A cell owned by a returning copy is drawn as a plain mesh, not as an instance.
      if (copies.has(row)) continue;
      const dy = base(row) - s.column.y, dz = row * ROW_SPACING + rail.value - s.column.z;
      const [pool, band, raised] = shelfField(0, dy, dz);
      worst.rim = Math.max(worst.rim, raised * band);
      worst.poolLost = Math.max(worst.poolLost, selectionPool(0, dz) - pool);
      worst.byHeight = Math.max(worst.byHeight, liftedField(0, dy, dz)[2]);
    }
  }
  return worst;
};
let raisedByHeight = 0;
for (const [label, reduced, presses, interval] of [['one reduced-motion step', true, 1, 60], ['a 10 rows/s scroll', false, 20, 6]]) for (const direction of [1, -1]) {
  const worst = stepping(reduced, direction, presses, interval);
  raisedByHeight = Math.max(raisedByHeight, worst.byHeight);
  assert.ok(worst.column < 0.3 && worst.byHeight > 0.5, `During ${label} the column drops to shelf level, where height alone would count shelf rows as raised`);
  assert.equal(worst.rim, 0, `Shelf rows carry no rim during ${label}`);
  assert.ok(worst.poolLost < 1e-12, `The pool in front does not blink during ${label}`);
}
const themed = setup();
themed.light.setTheme('night', new THREE.DirectionalLight());
assert.deepEqual(themed.shader.uniforms.musicPoolTint.value.toArray(), [...SELECTION_POOL_TINT.night], 'The pool tint follows the theme');
// One focus value scales all three terms: the shelf share of the view, thinned by travel.
const opened = setup();
opened.light.update(opened.model,opened.camera,1/60,true,false,false,0);
assert.equal(opened.light.focus,0,'An opened case shows no shelf emphasis');
assert.equal(opened.light.songFocus,0,'nor the song scene\'s, unless that scene is shown');
// The song scene: the large card is the raised case and keeps its rim; the chain lies in shade.
const song = setup();
song.light.update(song.model,song.camera,1/60,true,false,false,0,0,0,1);
assert.equal(song.light.focus,0,'The song scene shows no shelf band or pool');
assert.equal(song.light.songFocus,1,'but its own share');
assert.equal(song.shader.uniforms.musicSong.value,1,'which reaches the shaders');
song.light.update(song.model,song.camera,1/60,true,false,false,0,0,0,.4);
assert.equal(song.light.songFocus,.4,'and follows the scene as it opens');
song.light.update(song.model,song.camera,1/60,true,false,false,0,0,0,3);
assert.equal(song.light.songFocus,1,'clamped');
song.light.update(song.model,song.camera,1/60,false,false,false,0,0,0,1);
assert.equal(song.light.songFocus,0,'A hidden model shows none of it');
assert.equal(selectionSongShade(1,1),0,'The large card is never shaded');
assert.equal(selectionSongShade(0,1),SELECTION_SONG_SHADE,'A case resting in the chain takes the whole shade');
assert.equal(selectionSongShade(0,0),0,'Outside the song scene nothing is shaded this way');
assert.ok(SELECTION_SONG_SHADE>.4 && SELECTION_SONG_SHADE<=1,'The shade is a share of the pool tint');
// A returning copy passes from lit to shaded with its own lift (the scene sets card = 1 - songLiftHold):
// evenly, and it ends on exactly the shade of the shelf instance that takes its place.
{ const lift = MUSIC_MODEL.height + 0.12; let last = 0;
  for (let risen = lift; risen >= -1e-9; risen -= lift / 60) { const shade = selectionSongShade(1 - songLiftHold(Math.max(0, risen), lift),1); assert.ok(shade >= last - 1e-12 && shade - last < 0.12,`the shade grows evenly as a case sinks (${risen.toFixed(2)})`); last = shade; }
  assert.equal(last,SELECTION_SONG_SHADE,'no step when the copy retires');
  assert.equal(selectionSongShade(1 - songLiftHold(lift * 0.45, lift),1),0,'from 45 % of the lift upwards a case is the large card'); }
opened.light.update(opened.model,opened.camera,1/60,true,false,false,.25);
assert.equal(opened.light.focus,.25,'A resting light shows exactly the shelf share');
opened.light.update(opened.model,opened.camera,1/60,true,false,false,2);
assert.equal(opened.light.focus,1,'The shelf share is clamped');
const moving = setup();
moving.model.position.x=COLUMN_SPACING;
moving.light.update(moving.model,moving.camera,.1,true,false,false,.6);
assert.ok(moving.light.focus>0 && moving.light.focus<.6,'Travel thins the emphasis below the shelf share');
moving.light.update(moving.model,moving.camera,.1,true,true,false,.6);
assert.equal(moving.light.focus,.6,'Reduced motion shows the shelf share in one call');
moving.light.update(moving.model,moving.camera,.1,true,true,false,.6,3,-40);
assert.equal(moving.light.focus,.6,'A snapped column shows the shelf share whatever speed the shelf still has');
moving.light.update(moving.model,moving.camera,.1,true,false,true,.6,3,-40);
assert.equal(moving.light.focus,.6,'The opening shows the shelf share whatever speed the shelf has');
let slower = 1;
for(const distance of [ROW_SPACING,3*ROW_SPACING,COLUMN_SPACING/2,COLUMN_SPACING,2*COLUMN_SPACING,5*COLUMN_SPACING]) {
  const jump = setup();
  jump.model.position.x=distance;
  jump.light.update(jump.model,jump.camera,.1,true,false);
  assert.ok(jump.light.focus>0 && jump.light.focus<slower,'Focus falls monotonically with the speed of the light column');
  slower = jump.light.focus;
}
// The scene never carries the selection over a static shelf. The lifted case jumps to its
// new cell, then the track (rate 3.7) slides shelf and case back to the resting point
// together: what thins the emphasis is the speed at which rows pass the light column.
// `cellAt` is the selected cell's coordinate on the travelled axis, by time.
const travel = (axis,cellAt,seconds=3) => {
  const step = setup(), track = {value:0,velocity:0}, focus = [];
  for(let i=1;i<=seconds*120;i++) {
    const cell = cellAt(i/120);
    damp(track,cell,3.7,1/120);
    step.model.position[axis]=cell-track.value;
    step.light.update(step.model,step.camera,1/120,true,false,false,1,axis==='x'?-track.velocity:0,axis==='z'?-track.velocity:0);
    focus.push(step.light.focus);
  }
  return {focus,least:Math.min(...focus),settled:focus.at(-1)};
};
// The same travel, also recording how many rows the light column is from the selection.
const arrival = (cellAt,seconds=3) => {
  const step = setup(), track = {value:0,velocity:0}, trace = [];
  for(let i=1;i<=seconds*120;i++) {
    const cell = cellAt(i/120);
    damp(track,cell,3.7,1/120);
    step.model.position.z=cell-track.value;
    step.light.update(step.model,step.camera,1/120,true,false,false,1,0,-track.velocity);
    trace.push({time:i/120,focus:step.light.focus,rows:(step.light.columnPosition.z-step.model.position.z)/ROW_SPACING});
  }
  return trace;
};
const rowStep = travel('z',()=>ROW_SPACING), laneStep = travel('x',()=>COLUMN_SPACING);
assert.ok(rowStep.least>.95,'A one-row step keeps the emphasis');
assert.ok(laneStep.least>.3 && laneStep.least<.7,'A lane move hands the emphasis over without extinguishing it');
assert.ok(laneStep.settled>.999,'The emphasis re-forms once the light has arrived');
// A far album (shelf click, search, queue row): the emphasis thins while the rows stream
// past, forms once on the new selection and stays, with no flash in the middle of the travel.
const farJump = travel('z',()=>20*ROW_SPACING,5);
const thinnest = farJump.focus.indexOf(farJump.least);
const formed = farJump.focus.findIndex((focus,i) => i>thinnest && focus>.9), whole = farJump.focus.findIndex((focus,i) => i>thinnest && focus>.99);
const afterForming = Math.min(...farJump.focus.slice(whole));
assert.ok(farJump.least<.3,'A 20-row jump thins the emphasis while the rows stream past');
assert.ok(formed>thinnest && whole>=formed && Math.min(...farJump.focus.slice(formed))>=.9,'Once the emphasis has formed on the far album it does not fall away again');
assert.ok(farJump.settled>.999,'The emphasis is whole once the far album has arrived');
// The column runs a few rows past a far selection and glides back: the emphasis waits for
// it, rather than re-forming beside the album and sliding onto it.
for (const [name,cellAt,seconds] of [['a 15-row jump',()=>15*ROW_SPACING,5],['a 2 s wheel burst',time=>Math.min(55,Math.floor(time*27.5)+1)*ROW_SPACING,7]]) {
  const trace = arrival(cellAt,seconds);
  const overshoot = Math.max(...trace.map(({rows})=>rows));
  assert.ok(overshoot>3,`${name} carries the light column past the selection (${overshoot.toFixed(1)} rows)`);
  // The first frames after a new selection are the fade-out of the old place. From then
  // until the column starts back from its overshoot the emphasis stays thin, also while
  // the column sweeps across the selection on its way past it (the slow return).
  const back = trace.findLastIndex(({rows})=>Math.abs(rows)>3);
  const stray = Math.max(...trace.slice(0,back+1).filter(({time})=>time>.15).map(({focus})=>focus));
  assert.ok(stray<.42,`After ${name} the emphasis stays thin until the column is on its way back, also while it sweeps across the selection (${stray.toFixed(2)})`);
  const near = Math.min(...trace.filter(({time,rows})=>time>seconds-1.2 && Math.abs(rows)<.5).map(({focus})=>focus));
  assert.ok(near>.95,`After ${name} the emphasis is whole once the column is on the selection (${near.toFixed(2)})`);
  assert.ok(trace.at(-1).focus>.999);
  // On the way back it only grows.
  const low = trace.findIndex(({focus})=>focus<.1);
  const after = trace.slice(back);
  assert.ok(low>=0 && after.every(({focus},i)=>i===0 || focus>=after[i-1].focus-1e-9),`After ${name} the emphasis only grows once the column is on its way back`);
}
// The largest change within one 120 Hz frame: a new selection fades the old place out, it does not cut.
// The frame before the first one is the resting shelf (focus 1): a cut would happen right there.
const cut = (trace) => Math.max(...trace.map(({focus},i)=>Math.abs(focus-(i ? trace[i-1].focus : 1))));
assert.ok(cut(arrival(()=>ROW_SPACING))<.02,'A row step changes the emphasis gradually');
assert.ok(cut(arrival(()=>2*ROW_SPACING))<.08,'A two-row step fades the emphasis within a few frames');
// A held key or wheel at 20 rows/s for 2 s: rows keep passing the column, which rides at a
// constant lag from the selection and hardly moves in world space.
const scroll = travel('z',time=>Math.min(40,Math.floor(time*20)+1)*ROW_SPACING,7);
const scrolling = Math.max(...scroll.focus.slice(1.5*120,2*120));
assert.ok(scrolling<.7,'A sustained fast scroll keeps the emphasis thin instead of strobing it over every row');
assert.ok(scroll.settled>.999,'The emphasis re-forms when the scroll ends');
const poolBounds = new THREE.Box3();
const focus = {lane:2,row:12};
for(let index=0;index<LOOP_COLUMNS*LOOP_ROWS;index++) {
  const cell = visibleCell(index,focus);
  poolBounds.union(shellBounds.clone().translate(new THREE.Vector3(
    (cell.lane-focus.lane)*COLUMN_SPACING, 0, (cell.row-focus.row)*ROW_SPACING,
  )));
}
// Conservatively include the scan wave, preview/detail lift and returning CDs.
poolBounds.min.y -= 8;
poolBounds.max.y += 8;
let minimumClearance = Infinity;
for(const position of [[-89,3,1],[-62,70,8],[-62,36,43],[-20,17,67]]) {
  a.camera.position.set(...position);a.camera.lookAt(0,0,0);
  a.light.update(a.model,a.camera,0,true,true);
  const delta=a.light.spot.position.clone().sub(a.light.spot.target.position).applyQuaternion(a.camera.quaternion.clone().invert());
  assert.ok(delta.x<0 && delta.y<0,'Key remains screen lower-left through opening, shelf and detail');
  const sourceInPool = a.light.spot.position.clone().sub(a.model.position);
  const clearance = poolBounds.distanceToPoint(sourceInPool);
  minimumClearance = Math.min(minimumClearance,clearance);
  assert.ok(clearance>15,'Source stays well outside the full animated instance pool, preventing near-field corner burns');
  const direction = a.light.spot.target.position.clone().sub(a.light.spot.position).normalize();
  for(const side of [-1,1]) {
    const neighbor = a.light.spot.target.position.clone().add(new THREE.Vector3(side*COLUMN_SPACING,0,0));
    const incidence = neighbor.sub(a.light.spot.position).normalize().dot(direction);
    assert.ok(incidence>Math.cos(a.light.spot.angle),'Both adjacent genre columns lie inside the side-light cone');
  }
}
assert.equal(a.light.spot.distance,0,'Far source must not extinguish the shelf at a finite cutoff');

// The authored opening already eases its large track movement. The light must
// travel with that track on every frame, including a replay after live browsing.
const opening = setup();
opening.model.position.set(5.2,-4.6,-23);
opening.light.update(opening.model,opening.camera,1/60,true,false,true);
assert.ok(opening.column.distanceTo(opening.model.position)<1e-10,'Opening immediately anchors its light field to the entering array');
for(const displacement of [[0,.1,3],[0,.5,7],[0,-.2,8],[0,0,5]]) {
  const movement = new THREE.Vector3(...displacement);
  const oldTarget = opening.light.spot.target.position.clone();
  opening.model.position.add(movement);
  opening.light.update(opening.model,opening.camera,1/60,true,false,true);
  assert.ok(opening.column.distanceTo(opening.model.position)<1e-10,'Opening light field has no additional track lag');
  assert.ok(opening.light.spot.target.position.clone().sub(oldTarget).distanceTo(movement)<1e-10,'Side-light target shares the authored opening translation');
}
opening.model.position.x += COLUMN_SPACING;
opening.light.update(opening.model,opening.camera,.1,true,false);
assert.ok(opening.column.distanceTo(opening.model.position)>1,'Live browsing resumes its smooth handoff after opening');
opening.model.position.set(-5.2,-4.6,-23);
opening.light.update(opening.model,opening.camera,1/60,true,false,true);
assert.ok(opening.column.distanceTo(opening.model.position)<1e-10,'Replay discards the previous browsing anchor and velocity');
const replayTarget = opening.light.spot.target.position.clone();
opening.light.update(opening.model,opening.camera,1/60,true,false);
assert.ok(opening.column.distanceTo(opening.model.position)<1e-10,'A completed opening does not release residual light-field velocity');
assert.ok(opening.light.spot.target.position.distanceTo(replayTarget)<1e-10,'A completed opening does not release residual source velocity');
a.light.update(a.model,a.camera,0,false,false);
assert.equal(a.light.spot.visible,false);
assert.equal(a.light.focus,0,'An empty library shows no shelf emphasis');
assert.equal(a.light.spot.castShadow,false);
console.log(`Music lighting passed: actual 5×3.35 shell edge alignment, narrow warm ribbon, unchanged cover shader, gradual start, frame-rate independence, rapid reversal, reduced motion, lower-left direction, neighboring-column cone coverage, full-pool clearance ${minimumClearance.toFixed(2)}, cinematic track/replay anchoring, shelf emphasis (pool rows +2..+8 at ${selectionPool(0, 2 * ROW_SPACING).toFixed(2)}, row +1 at ${firstRow.toFixed(2)}, lit row and rim, print pool multiply-only), shelf rows never raised (height alone would count them up to ${raisedByHeight.toFixed(2)} raised while the column drops on a selection change), focus across the sliding shelf ${laneStep.least.toFixed(2)} at the middle of a lane move, ${rowStep.least.toFixed(2)} on a row step, ${farJump.least.toFixed(2)} in a 20-row jump (no lower than ${afterForming.toFixed(2)} once formed) and at most ${scrolling.toFixed(2)} in a 20 rows/s scroll, empty-library disable.`);
