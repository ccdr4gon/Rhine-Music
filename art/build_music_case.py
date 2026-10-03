"""Rhine Music album case: shelf parts plus the detail shown on the lifted case.

Run inside Blender through Blender MCP (execute this file with __file__ set to its absolute
path), or headless:  blender --background --factory-startup --python art/build_music_case.py

Authored at the runtime size in Three.js axes (X right, Y up, Z toward the viewer):
4.45 x 3.35 x DEPTH centred on (0, 1.85, 0). The album artwork stays a runtime surface print in
front of the case (z = DEPTH / 2 + 0.012), so nothing here may cover its 2.98 x 2.98 window at
(0.14, 1.85).

Every exported node carries extras.rhineLod:
  shared - drawn on every shelf instance and on the lifted case
  lod1   - shelf instances only (cheap stand-ins)
  lod0   - lifted case only; fades in with the lift and replaces its lod1 counterparts
Parts are merged per (level, surface) so the renderer keeps one batch per material.
Outputs: public/assets/music-case.glb, art/music-case.blend, src/music-case-asset.ts.
"""
import bpy
import bmesh
import hashlib
import math
from mathutils import Matrix, Vector
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = 'Rhine_Music_Case_Asset'
PREFIX = 'RMC_'

# Envelope and the album print window (runtime units). A slab as deep as the upstream archive
# boxes in proportion (about 1/12 of the height): half of the 0.62 shelf pitch stays open.
DEPTH = 0.28
X0, X1, Y0, Y1, Z0, Z1 = -2.225, 2.225, 0.175, 3.525, -DEPTH / 2, DEPTH / 2
SKIN = 0.032  # frosted cover and back plate
SEAM = 0.002  # gap between stacked layers, so each end face reads as three
RAIL = Z1 - SKIN - SEAM  # the carrier rails fill the depth between the skins
SPINE_X = -1.985
PRINT = (0.14 - 1.49, 0.14 + 1.49, 1.85 - 1.49, 1.85 + 1.49)  # x0, x1, y0, y1
FACE = Z1  # front plane of the cover and spine
SURFACE_Z = FACE + 0.0005  # flush printed/pressed details sit on the face


def three(x, y, z):
    """Three.js (Y up, +Z to viewer) to Blender (Z up, -Y to viewer); glTF export maps it back."""
    return Vector((x, -z, y))


# ---------------------------------------------------------------- scene setup
def remove_previous():
    old = bpy.data.scenes.get(WORK)
    if old is not None:
        for obj in list(old.objects):
            if obj.name.startswith(PREFIX):
                bpy.data.objects.remove(obj, do_unlink=True)
        if bpy.context.window is not None and bpy.context.window.scene == old:
            other = next((s for s in bpy.data.scenes if s != old), None) or bpy.data.scenes.new('Scene')
            bpy.context.window.scene = other
        if len(bpy.data.scenes) > 1:
            bpy.data.scenes.remove(old)
    for collection in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for block in list(collection):
            if block.users == 0 and (block.name.startswith(PREFIX) or block.name in SURFACES):
                collection.remove(block)


SURFACES = {
    # name: (base colour, roughness, metallic, transmission) - preview values only; the
    # renderer configures every music surface itself.
    'Frosted_Polymer': ((.985, .975, .963), .36, 0, .9),
    'Ivory_Edges': ((.94, .916, .892), .28, .02, .3),
    'Optical_Diffuser': ((.925, .902, .881), .67, 0, 0),
    'Index_Inlay': ((.74, .55, .33), .48, .06, 0),
    'Titanium_Fasteners': ((.58, .60, .61), .19, .82, 0),
    'Case_Engraving': ((.42, .40, .37), .45, .08, 0),
    'Case_Engraving_Highlight': ((.93, .91, .87), .25, .1, 0),
    'Moulded_Lettering': ((.80, .775, .74), .26, .1, 0),
    'Printed_Label': ((.93, .915, .88), .62, 0, 0),
    'Champagne_Index': ((.70, .52, .33), .33, .45, 0),
    'Optical_Edges': ((.90, .885, .86), .3, .05, 0),
}

remove_previous()
if bpy.context.window is not None:
    scene = bpy.data.scenes.new(WORK)
    bpy.context.window.scene = scene
else:
    scene = bpy.context.scene
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    scene.name = WORK

MATERIALS = {}
for name, (color, rough, metal, transmission) in SURFACES.items():
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    if not mat.node_tree:
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Transmission Weight'].default_value = transmission
    bsdf.inputs['IOR'].default_value = 1.46
    MATERIALS[name] = mat

PARTS = []  # (object, level, surface)


def add(obj, level, surface):
    obj['rhineLod'] = level
    PARTS.append((obj, level, surface))
    return obj


def mesh_object(name, bm, surface, level, smooth=True):
    mesh = bpy.data.meshes.new(PREFIX + name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(MATERIALS[surface])
    if smooth:
        mesh.shade_smooth()
    obj = bpy.data.objects.new(PREFIX + name, mesh)
    scene.collection.objects.link(obj)
    return add(obj, level, surface)


def finish_edges(obj, bevel, segments=2):
    if bevel > 0:
        mod = obj.modifiers.new('Machined edge', 'BEVEL')
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = 'ANGLE'
    mod = obj.modifiers.new('Weighted normals', 'WEIGHTED_NORMAL')
    mod.keep_sharp = True
    mod.mode = 'FACE_AREA'
    return obj


# ---------------------------------------------------------------- primitives
def box(name, surface, level, x0, x1, y0, y1, z0, z1, bevel=0.0, segments=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = three(x1 if v.co.x > 0 else x0, y1 if v.co.z > 0 else y0, z0 if v.co.y > 0 else z1)
    return finish_edges(mesh_object(name, bm, surface, level), bevel, segments)


def disc(name, surface, level, cx, cy, z0, z1, radius, segments, bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments,
                          radius1=radius, radius2=radius, depth=z1 - z0)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'X'))
    bmesh.ops.translate(bm, verts=bm.verts, vec=three(cx, cy, (z0 + z1) / 2))
    return finish_edges(mesh_object(name, bm, surface, level), bevel, 2 if bevel else 1)


def annulus(name, surface, level, cx, cy, profile, segments=64, start=0.0, end=2 * math.pi):
    """Revolve a closed (radius, z) section around the face normal at (cx, cy)."""
    closed = abs(end - start - 2 * math.pi) < 1e-6
    rows = segments if closed else segments + 1
    n = len(profile)
    bm = bmesh.new()
    verts = []
    for i in range(rows):
        a = start + (end - start) * i / segments
        verts.append([bm.verts.new(three(cx + r * math.cos(a), cy + r * math.sin(a), z)) for r, z in profile])
    for i in range(segments):
        nxt = (i + 1) % rows
        for j in range(n):
            bm.faces.new((verts[i][j], verts[nxt][j], verts[nxt][(j + 1) % n], verts[i][(j + 1) % n]))
    if not closed:
        bm.faces.new(list(reversed(verts[0])))
        bm.faces.new(verts[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_object(name, bm, surface, level)


def ribbon(name, surface, level, points, width, z):
    """Flat pressed line on the face: one quad per segment, extended to close the joints."""
    bm = bmesh.new()
    for (ax, ay), (bx, by) in zip(points, points[1:]):
        d = Vector((bx - ax, by - ay))
        if d.length < 1e-6:
            continue
        d.normalize()
        n = Vector((-d.y, d.x)) * (width / 2)
        e = d * (width / 2)
        a = Vector((ax, ay)) - e
        b = Vector((bx, by)) + e
        quad = [a - n, b - n, b + n, a + n]
        bm.faces.new([bm.verts.new(three(p.x, p.y, z)) for p in quad])
    return mesh_object(name, bm, surface, level, smooth=False)


def engraved(name, points, width=0.0072):
    # A dark pressed channel with a lit lower-right lip, both flush on the cover face.
    ribbon(name + ' channel', 'Case_Engraving', 'lod0', points, width, SURFACE_Z + 0.0006)
    lip = [(x + 0.0042, y - 0.0042) for x, y in points]
    ribbon(name + ' lip', 'Case_Engraving_Highlight', 'lod0', lip, width * 0.8, SURFACE_Z + 0.0003)


def lettering(name, surface, body, x, y, size, vertical=False, spacing=1.0, z=SURFACE_Z, depth=0.0012):
    curve = bpy.data.curves.new(PREFIX + name, 'FONT')
    curve.body = body
    curve.size = size
    curve.extrude = depth / 2
    curve.space_character = spacing
    curve.align_x = 'LEFT'
    obj = bpy.data.objects.new(PREFIX + name, curve)
    scene.collection.objects.link(obj)
    curve.materials.append(MATERIALS[surface])
    obj.location = three(x, y, z + depth / 2)
    obj.rotation_euler = (math.pi / 2, math.pi / 2 if vertical else 0, 0)
    return add(obj, 'lod0', surface)


# ---------------------------------------------------------------- shared shell
# The spine wraps the whole depth; cover, carrier rails and back plate stack between
# small seam gaps so every end face reads as three layers from the shelf camera.
box('Spine', 'Ivory_Edges', 'shared', X0, SPINE_X, Y0, Y1, Z0, Z1, bevel=0.012, segments=3)
box('Frosted cover', 'Frosted_Polymer', 'shared', SPINE_X + SEAM, X1, Y0, Y1, Z1 - SKIN, Z1, bevel=0.006)
box('Back plate', 'Optical_Diffuser', 'shared', SPINE_X + SEAM, X1, Y0, Y1, Z0, Z0 + SKIN, bevel=0.006)
INSET = 0.004
box('Top carrier rail', 'Ivory_Edges', 'shared', SPINE_X + SEAM, X1 - INSET, Y1 - 0.05, Y1 - INSET, -RAIL, RAIL, bevel=0.003)
box('Bottom carrier rail', 'Ivory_Edges', 'shared', SPINE_X + SEAM, X1 - INSET, Y0 + INSET, Y0 + 0.05, -RAIL, RAIL, bevel=0.003)
box('Right carrier rail', 'Ivory_Edges', 'shared', X1 - 0.05, X1 - INSET, Y0 + 0.05, Y1 - 0.05, -RAIL, RAIL, bevel=0.003)
# Index inlay: flush amber key at the top-left, wrapping onto the top end face.
box('Index inlay', 'Index_Inlay', 'shared', -1.955, -1.715, Y1 - 0.215, Y1 + 0.0015, FACE - 0.012, FACE + 0.0012, bevel=0.0015, segments=1)

# ---------------------------------------------------------------- fasteners
SCREWS = [(1.935, 3.255), (-1.665, 0.445)]
for i, (sx, sy) in enumerate(SCREWS):
    # Shelf stand-in: a 12-sided flat head, a few pixels wide at shelf distance.
    disc(f'Shelf screw {i}', 'Titanium_Fasteners', 'lod1', sx, sy, FACE - 0.002, FACE + 0.006, 0.058, 12)
    # Lifted case: machined head with a cross recess, seated in a countersunk washer.
    head = disc(f'Machined screw {i}', 'Titanium_Fasteners', 'lod0', sx, sy, FACE - 0.002, FACE + 0.006, 0.058, 48, bevel=0.0018)
    for angle in (0.35, 0.35 + math.pi / 2):
        cutter = box(f'Screw drive cutter {i} {angle:.2f}', 'Case_Engraving', 'cutter', -0.036, 0.036, -0.0055, 0.0055, FACE + 0.0025, FACE + 0.02)
        cutter.matrix_world = Matrix.Translation(three(sx, sy, 0)) @ Matrix.Rotation(angle, 4, 'Y')
        cutter.hide_render = True
        cutter.display_type = 'WIRE'
        mod = head.modifiers.new('Cross recess', 'BOOLEAN')
        mod.operation = 'DIFFERENCE'
        mod.solver = 'EXACT'
        mod.object = cutter
        head.modifiers.move(len(head.modifiers) - 1, 0)
    annulus(f'Countersunk washer {i}', 'Case_Engraving_Highlight', 'lod0', sx, sy,
            [(0.060, FACE + 0.0005), (0.075, FACE + 0.0005), (0.075, FACE + 0.0022), (0.066, FACE + 0.0032), (0.060, FACE + 0.0032)], 48)
    # C-shaped pressed boss around each head, open towards the case centre.
    toward = math.atan2(1.85 - sy, 0.14 - sx)
    for radius in (0.096, 0.116):
        arc = [(sx + radius * math.cos(toward + 0.55 + t * (2 * math.pi - 1.1) / 40),
                sy + radius * math.sin(toward + 0.55 + t * (2 * math.pi - 1.1) / 40)) for t in range(41)]
        engraved(f'Screw boss {i} {radius:.3f}', arc, 0.0062)

# ---------------------------------------------------------------- pressed routes
px0, px1, py0, py1 = PRINT
FRAME = 0.045  # clearance between the print and the inner frame route
# The top route steps down around the index inlay before running down the left margin.
engraved('Outer upper left', [(2.10, Y1 - 0.06), (-1.68, Y1 - 0.06), (-1.68, 3.285), (SPINE_X + 0.035, 3.285),
                              (SPINE_X + 0.035, 0.66)])
engraved('Outer lower right', [(X1 - 0.06, Y1 - 0.13), (X1 - 0.06, Y0 + 0.06), (-1.20, Y0 + 0.06)])
c = 0.07  # chamfer
fx0, fx1, fy0, fy1 = px0 - FRAME, px1 + FRAME, py0 - FRAME, py1 + FRAME
engraved('Inner frame', [(fx0, fy1 - 0.42), (fx0, fy0 + c), (fx0 + c, fy0), (fx1 - c, fy0), (fx1, fy0 + c),
                         (fx1, fy1 - c), (fx1 - c, fy1), (fx0 + 0.30, fy1)])
engraved('Upper circuit', [(fx0 + 0.42, Y1 - 0.105), (-0.32, Y1 - 0.105), (-0.29, Y1 - 0.085), (0.52, Y1 - 0.085),
                           (0.55, Y1 - 0.105), (1.30, Y1 - 0.105)], 0.0058)
engraved('Right hook', [(fx1 + 0.06, 2.95), (fx1 + 0.06, 2.02), (fx1 + 0.11, 1.97), (X1 - 0.11, 1.97)], 0.0058)
engraved('Left return', [(fx0 - 0.05, 2.70), (fx0 - 0.05, 0.86), (fx0 - 0.10, 0.81), (SPINE_X + 0.11, 0.81)], 0.0058)

# Calibration ladder between the left route and the label column.
for i in range(34):
    y = 0.96 + i * 0.052
    long = i % 5 == 0
    x0 = fx0 - 0.105
    ribbon(f'Calibration tick {i}', 'Case_Engraving', 'lod0', [(x0 - (0.07 if long else 0.035), y), (x0, y)], 0.0055, SURFACE_Z + 0.0006)

# Diagonal vents under the print, right of centre.
for i in range(12):
    x = 0.86 + i * 0.058
    # Between the outer route (y 0.235) and the inner frame (y 0.315).
    ribbon(f'Vent {i}', 'Case_Engraving', 'lod0', [(x - 0.020, Y0 + 0.084), (x + 0.016, Y0 + 0.12)], 0.011, SURFACE_Z + 0.0006)
    ribbon(f'Vent lip {i}', 'Case_Engraving_Highlight', 'lod0', [(x - 0.016, Y0 + 0.08), (x + 0.020, Y0 + 0.116)], 0.007, SURFACE_Z + 0.0003)

# Service socket in the right margin: two pressed rings around an amber pin.
sx, sy = 1.935, 1.42
annulus('Service socket outer', 'Optical_Edges', 'lod0', sx, sy,
        [(0.100, SURFACE_Z), (0.114, SURFACE_Z), (0.114, SURFACE_Z + 0.0016), (0.100, SURFACE_Z + 0.0016)], 48)
annulus('Service socket inner', 'Case_Engraving', 'lod0', sx, sy,
        [(0.056, SURFACE_Z + 0.0004), (0.068, SURFACE_Z + 0.0004), (0.068, SURFACE_Z + 0.0012), (0.056, SURFACE_Z + 0.0012)], 40)
disc('Service socket pin', 'Champagne_Index', 'lod0', sx, sy, SURFACE_Z, SURFACE_Z + 0.002, 0.024, 24, bevel=0.0006)

# Label plate; the album number and format are drawn on it at runtime.
box('Label plate', 'Printed_Label', 'lod0', -1.925, fx0 - 0.05, 2.86, 3.24, FACE - 0.001, FACE + 0.0016, bevel=0.0008, segments=1)

# Spine lettering, pressed into the full-depth spine and read top to bottom.
lettering('Spine lettering', 'Moulded_Lettering', 'RHINE LAB  ·  MUSIC ARCHIVE', -2.143, 3.30, 0.088, vertical=True, spacing=1.12)

# ---------------------------------------------------------------- bake and merge
depsgraph = bpy.context.evaluated_depsgraph_get()
depsgraph.update()
baked = {}
for obj, level, surface in PARTS:
    if level == 'cutter':
        continue
    evaluated = obj.evaluated_get(depsgraph)
    mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
    mesh.transform(obj.matrix_world)
    if not mesh.materials:
        mesh.materials.append(MATERIALS[surface])
    baked.setdefault((level, surface), []).append(mesh)
for obj, _level, _surface in PARTS:
    data = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if data is not None and data.users == 0:
        (bpy.data.curves if isinstance(data, bpy.types.Curve) else bpy.data.meshes).remove(data)

triangles = {}
for (level, surface), meshes in sorted(baked.items()):
    bm = bmesh.new()
    for mesh in meshes:
        bm.from_mesh(mesh)
    name = surface if level == 'shared' else f'{level.upper()}_{surface}'
    merged = bpy.data.meshes.new(PREFIX + name)
    bm.to_mesh(merged)
    bm.free()
    # bmesh drops custom split normals: rebuild them from the sources in loop order.
    normals = [n.vector.copy() for mesh in meshes for n in mesh.corner_normals]
    merged.normals_split_custom_set(normals)
    merged.materials.append(MATERIALS[surface])
    for mesh in meshes:
        bpy.data.meshes.remove(mesh)
    obj = bpy.data.objects.new(PREFIX + name, merged)
    obj['rhineLod'] = level
    obj['musicCase'] = True
    scene.collection.objects.link(obj)
    merged.calc_loop_triangles()
    triangles[name] = len(merged.loop_triangles)

# ---------------------------------------------------------------- export
glb = ROOT / 'public/assets/music-case.glb'
for obj in scene.objects:
    obj.select_set(obj.name.startswith(PREFIX))
bpy.ops.export_scene.gltf(filepath=str(glb), export_format='GLB', use_active_scene=True, use_selection=True,
                          export_apply=True, export_extras=True, export_yup=True, export_cameras=False,
                          export_lights=False, export_materials='EXPORT')
digest = hashlib.sha256(glb.read_bytes()).hexdigest()[:12]
(ROOT / 'src/music-case-asset.ts').write_text(
    '// Generated by art/build_music_case.py; changes invalidate the browser asset cache.\n'
    f'export const MUSIC_CASE_ASSET = "assets/music-case.glb?v={digest}";\n', encoding='utf-8')
bpy.data.libraries.write(str(ROOT / 'art/music-case.blend'), {scene}, fake_user=True)

shelf = sum(t for n, t in triangles.items() if not n.startswith('LOD0_'))
lifted = sum(t for n, t in triangles.items() if not n.startswith('LOD1_'))
print('Music case exported:', glb.stat().st_size, 'bytes;', 'shelf instance', shelf, 'triangles; lifted case', lifted, 'triangles')
for name, count in sorted(triangles.items()):
    print(f'  {name}: {count}')
