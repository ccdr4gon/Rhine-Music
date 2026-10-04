import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LANE_LABEL, laneLabelIndex, laneLabelPlace, laneLabelRange, laneLabelSpan,
} from '../src/lane-labels.ts';

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

test('names stand on the clear side of the lifted case: behind it for the selected and the further column, in front for the nearer one', () => {
  const selected = laneLabelPlace(0);
  assert.deepEqual(selected, { row: LANE_LABEL.selected, align: 1, share: 1 }, 'the name ends behind the selected row');
  assert.ok(LANE_LABEL.selected <= -0.5, 'clear of the lifted case, which is under half a row thick (0.28 of 0.62)');
  // The column further from the lens: its name ends further back still, so the line of sight
  // to it passes behind the lifted case, not through it.
  const further = laneLabelPlace(1);
  assert.deepEqual(further, { row: LANE_LABEL.selected - LANE_LABEL.behind, align: 1, share: 1 });
  assert.ok(further.row <= -1.5 && LANE_LABEL.behind >= 1.5);
  // The column nearer the lens: its rows behind the selection are out of the picture.
  const nearer = laneLabelPlace(-1);
  assert.deepEqual(nearer, { row: LANE_LABEL.front, align: 0, share: 1 }, 'its name starts in front of the selected row');
  assert.ok(nearer.row >= 0.5, 'and does not stand over the lifted case either');
  // What a name covers: it ends at, or starts from, its place.
  assert.deepEqual(laneLabelSpan(selected, 4), { from: LANE_LABEL.selected - 4, to: LANE_LABEL.selected });
  assert.deepEqual(laneLabelSpan(further, 4), { from: further.row - 4, to: further.row });
  assert.deepEqual(laneLabelSpan(nearer, 4), { from: LANE_LABEL.front, to: LANE_LABEL.front + 4 });
});

test('a name travels with its column without a jump, and leaves two columns out', () => {
  let previous = laneLabelPlace(-2.5);
  for (let offset = -2.5 + 0.01; offset <= 2.5; offset += 0.01) {
    const place = laneLabelPlace(offset);
    assert.ok(Math.abs(place.row - previous.row) <= Math.max(LANE_LABEL.step, LANE_LABEL.behind) * 0.01 + 1e-9, `row jumps at ${offset}`);
    assert.ok(Math.abs(place.align - previous.align) <= 0.01 + 1e-9, `alignment jumps at ${offset}`);
    assert.ok(Math.abs(place.share - previous.share) <= 0.04, `visibility jumps at ${offset}`);
    assert.ok(place.share >= 0 && place.share <= 1 && place.align >= 0 && place.align <= 1);
    previous = place;
  }
  assert.equal(laneLabelPlace(LANE_LABEL.reach).share, 1, 'fully shown up to the reach');
  assert.equal(laneLabelPlace(-LANE_LABEL.reach).share, 1);
  assert.equal(laneLabelPlace(LANE_LABEL.reach + LANE_LABEL.fade).share, 0, 'gone a fade further');
  assert.equal(laneLabelPlace(-2).share, 0);
  assert.equal(laneLabelPlace(2).share, 0);
  near(laneLabelPlace(0.5).row, LANE_LABEL.selected - LANE_LABEL.behind / 2, 'half way to the further column');
  assert.equal(laneLabelPlace(0.5).align, 1, 'which keeps ending at its place');
  near(laneLabelPlace(-0.5).row, (LANE_LABEL.selected + LANE_LABEL.front) / 2, 'half way to the nearer column');
  near(laneLabelPlace(-0.5).align, 0.5, 'and half way between ending and starting there');
  // Columns further out keep moving away instead of piling up on the neighbour's place.
  assert.ok(laneLabelPlace(1.5).row < laneLabelPlace(1).row);
  assert.ok(laneLabelPlace(-1.5).row > laneLabelPlace(-1).row);
});

test('the columns that can be named are exactly those with something to show', () => {
  for (const centre of [0, 2, 2.3, 2.5, 2.74, 2.76, -7.5, 40.999]) {
    const { first, last } = laneLabelRange(centre);
    for (let lane = Math.floor(centre) - 4; lane <= Math.ceil(centre) + 4; lane++) {
      const shown = laneLabelPlace(lane - centre).share > 0;
      if (shown) assert.ok(lane >= first && lane <= last, `lane ${lane} around ${centre} is in the range`);
    }
    assert.ok(last - first <= 3, 'at most four columns at once (three at rest)');
  }
  assert.deepEqual(laneLabelRange(2), { first: 1, last: 3 });
});

test('portrait: the columns under the title are not named, the others are', () => {
  assert.equal(laneLabelPlace(-1, true).share, 0);
  assert.equal(laneLabelPlace(-LANE_LABEL.fade, true).share, 0);
  assert.equal(laneLabelPlace(0, true).share, 1);
  assert.equal(laneLabelPlace(1, true).share, 1);
  assert.equal(laneLabelPlace(-1, false).share, 1, 'landscape names it');
  const half = laneLabelPlace(-LANE_LABEL.fade / 2, true).share;
  assert.ok(half > 0 && half < 1, 'and it fades in as its column becomes the selected one');
  // The place itself is the same in both layouts: only what is shown differs.
  assert.equal(laneLabelPlace(-0.4, true).row, laneLabelPlace(-0.4).row);
});

test('a column is counted as the stepper counts it', () => {
  assert.equal(laneLabelIndex(0), '01');
  assert.equal(laneLabelIndex(11), '12');
});

test('the scene places the names where they are seen', () => {
  const scene = readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');
  const place = scene.slice(scene.indexOf('private placeLaneLabels('), scene.indexOf('private createLanePlates('));
  assert.ok(place.length > 500, 'placeLaneLabels is in the scene');
  assert.equal((place.match(/laneLabelPlace\(/g) || []).length, 1, 'one place for a column');
  // Names are only written in the scene: no tags placed over the picture.
  assert.doesNotMatch(scene, /laneTags|laneStyle|LaneLabelStyle/);
  assert.match(place, /isPortraitViewport\(/, 'the portrait rule comes from viewport-layout.ts');
  assert.doesNotMatch(place, /clientWidth\s*[<>]|innerWidth/, 'no screen-width threshold of its own');
  // A name stands on the top edge of the cases: the model's centre plus half its height.
  assert.match(place, /const caseTop = MUSIC_MODEL\.center\.y \+ MUSIC_MODEL\.height \/ 2;/);
  assert.match(place, /field\(centre\.row \+ row, lane\) \+ caseTop \+ LANE_LABEL\.rise/);
  assert.ok(LANE_LABEL.rise > 0 && LANE_LABEL.rise < 0.2 && LANE_LABEL.clear > 0);
  // Each end stands on its own line of sight over the column in front (no shared lift).
  assert.match(place, /stand\(start, lane, x, span\.from\);\s*stand\(end, lane, x, span\.to\);/);
  assert.doesNotMatch(place, /Math\.max\(\.\.\.lifts\)/);
  // A lone column repeats in every lane and is named once.
  assert.match(place, /const lone = archiveColumns\.length === 1 \? Math\.max\(0, 1 - 2 \* Math\.abs\(offset\)\) : 1;\s*const share = place\.share \* shown \* lone;/);
  // Names are part of the browsing view only.
  assert.match(scene, /this\.placeLaneLabels\(field, center, trackX, entryZ,\s*musicLibrary && !cinematic \|\| musicIntro \? \(musicIntro \? introSettle : 1\) \* \(1 - detail\) \* \(1 - songProgress\) : 0\)/);
  // The frame description covers names that are not in the scene graph's visible set.
  assert.match(scene, /this\.lanePlates\?\.describe\(\(value\) => p\.value\(value\)\)/);
});

test('a name in the scene is text only, and is never drawn as a solid rectangle', () => {
  const scene = readFileSync(new URL('../src/scene.ts', import.meta.url), 'utf8');
  const plates = readFileSync(new URL('../src/lane-plates.ts', import.meta.url), 'utf8');
  const write = plates.slice(plates.indexOf('  write(column'), plates.indexOf('  pose(start'));
  // Everything that reaches the mask: the helper that draws a piece of text, and write().
  const drawing = plates.slice(plates.indexOf('function writeText('), plates.indexOf('/** What a name is written with')) + write;
  assert.ok(drawing.length > write.length + 400, 'the text helper is part of what is checked');
  // Nothing but glyphs is written: no plate, frame, bar or line. The only rectangles are the
  // clearing of the mask and the flattening of the scratch canvas, both the whole canvas.
  assert.doesNotMatch(drawing, /strokeRect|fillRect\((?!0, 0, CANVAS_WIDTH, CANVAS_HEIGHT\))|\.stroke\(|lineTo|\.arc\(|\.rect\(|roundRect|strokeText|\.fill\(\)/, 'no shape but the whole canvas');
  assert.equal((drawing.match(/fillRect\(/g) || []).length, 2);
  assert.equal((write.match(/writeText\(/g) || []).length, 4, 'the number and the name, each with its rim');
  assert.doesNotMatch(write, /context\.fillText\(/, 'text goes through the flattening helper');
  assert.equal((drawing.match(/\.fillText\(/g) || []).length, 2, 'the rim is the text\'s own shadow, drawn with the text at most twice');
  // The rim follows the strokes: a few canvas pixels (two or three on screen at most), and
  // no stronger than it is: it must not grow back into a band behind the name.
  const blur = Number(/const GROUND_BLUR = (\d+);/.exec(plates)?.[1]);
  assert.ok(blur >= 1 && blur <= 4, `the rim is thin (${blur} canvas pixels)`);
  const strength = Number(/const GROUND_STRENGTH = (\d\.\d+);/.exec(plates)?.[1]);
  assert.ok(strength > 0 && strength <= 0.7, `and not opaque (${strength})`);
  // Colour glyphs give the mask coverage only.
  assert.match(plates, /scratch\.globalCompositeOperation = "source-in";\s*scratch\.fillStyle = colour;/);
  // The playing queue's column is marked by the colour of its number, not by a mark beside it.
  assert.match(write, /writeText\(context, index, x, INDEX_FONT, label\.live \? "#0f0" : "#b30000"\);/);
  // The shader draws glyph coverage (and the soft ground under it) and nothing where there is none.
  assert.match(plates, /float glyph = min\( written\.r \+ written\.g, 1\.0 \) \* weight;/);
  assert.match(plates, /float cover = max\( glyph, written\.b \* \$\{GROUND_STRENGTH\.toFixed\(2\)\} \);\s*float alpha = opacity \* cover;/);
  assert.match(plates, /if \( alpha <= 0\.002 \) discard;/);
  assert.doesNotMatch(plates, /uniform vec3 plate;|vFace|border/, 'no plate colour and no rectangle edge is left in the shader');
  // Both meshes are transparent and write no depth for their rectangle.
  assert.match(plates, /name: "LanePlate", uniforms: uniforms\(\), vertexShader, fragmentShader,\s*transparent: true, depthWrite: false,/);
  assert.match(plates, /defines: \{ LANE_PLATE_OVERLAY: "" \}, transparent: true, depthTest: false, depthWrite: false,/);
  assert.match(plates, /mesh\.visible = !late;\s*overlay\.visible = late;/, 'a name is drawn once: in the scene, or after its passes');
  // The lens's depth and ambient occlusion draw every mesh as a solid: with either on, the
  // names are left out of the scene and drawn after it, against the scene's depth.
  const place = scene.slice(scene.indexOf('private placeLaneLabels('), scene.indexOf('private createLanePlates('));
  assert.match(place, /plate\.pose\(start, end, share, [^;]*this\.bokeh\.enabled \|\| this\.ao\.enabled\)/);
  assert.match(scene, /this\.composer\.addPass\(this\.bokeh\);[\s\S]{0,1400}this\.composer\.addPass\(this\.lanePlateOverlay\);/);
  assert.match(scene, /if \(this\.bokeh\.enabled && this\.bokeh\.exactDepth && uniforms\.tDepth\.value\)\s*return \{ texture: uniforms\.tDepth\.value, packed: true,/);
  assert.match(scene, /const target = this\.ao\.enabled \? this\.ao\.normalRenderTarget : undefined;\s*return target\?\.depthTexture\s*\? \{ texture: target\.depthTexture, packed: false, width: target\.width, height: target\.height,/);
  assert.match(plates, /float depth = sceneDepthPacked > 0\.5 \? unpackRGBAToDepth\( stored \) : stored\.x;/);
  assert.match(plates, /for \(const plate of this\.plates\) if \(plate\.used\) plate\.describe\(value\)/);
  // Ambient occlusion's depth can be coarser than the picture: the occlusion taps are a texel of it apart.
  assert.match(plates, /\( gl_FragCoord\.xy \+ corner \* sceneDepthStep \) \/ resolution/);
  assert.match(plates, /uniforms\.sceneDepthStep\.value\.set\(Math\.max\(1, readBuffer\.width \/ Math\.max\(1, depth\.width\)\)/);
  // A name that was shown last frame is left for its own lane: stepping sideways rewrites one name, not all.
  assert.match(plates, /\?\? free\.find\(\(candidate\) => !candidate\.mesh\.visible && !candidate\.overlay\.visible\);/);
  assert.doesNotMatch(plates, /\?\? free\[0\]/);
});

test('the app names columns from the playlists shown, in one way only', () => {
  const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  // The names follow the library's columns the moment the library changes.
  assert.match(app, /setMusicAlbums\(albums, genres, displaySort\);\s*syncLaneLabels\(\);/);
  assert.match(app, /laneNames = queueLanesShown\.length\s*\? archiveColumns\.map/, 'no playlist columns, no names');
  assert.match(app, /scene\?\.setLaneLabels\(laneNames\);/);
  // The tag style is gone: no element, no placement, no style preference.
  assert.doesNotMatch(app, /lane-tags|placeLaneTags|preferences\.laneNameStyle|LANE_LABEL_STYLES/);
  const css = readFileSync(new URL('../src/external-media.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.lane-tag/);

});
