import * as THREE from "three";
import { MUSIC_COVER } from "./music-model.ts";

import type { CoverMip } from "./cover-mipmaps.ts";
export { coverMipmaps, type CoverMip } from "./cover-mipmaps.ts";

/** Every level contains independent tiles, including the final one texel per cover. */
export class CoverMipTexture extends THREE.DataTexture {
  declare mipmaps: CoverMip[];
  readonly coverAnisotropy = { value: 1 };
  /** Printed art size relative to the full cover square; drives a single print's quad. */
  readonly coverScale = { value: new THREE.Vector2(1, 1) };
  /** Finest level that holds valid art; higher while a sharper chain is still being prepared. */
  readonly coverMinLod = { value: 0 };
  private readonly dirtyTiles = new Set<number>();
  /** Counts changes to any cover's art; a frame showing changed art must be drawn. */
  static revision = 0;
  constructor(readonly columns: number, readonly rows: number, readonly tileSize: number, anisotropy = 1) {
    super();
    this.mipmaps = [];
    for (let size = tileSize; size >= 1; size /= 2)
      this.mipmaps.push({ data: new Uint8Array(columns * rows * size * size * 4), width: columns * size, height: rows * size });
    this.image = this.mipmaps[0];
    this.colorSpace = THREE.SRGBColorSpace;
    this.generateMipmaps = false;
    this.minFilter = THREE.LinearMipmapNearestFilter;
    this.magFilter = THREE.LinearFilter;
    // The shader performs bounded, tile-local anisotropic sampling. Hardware
    // anisotropy would cross tile borders after the per-level UV clamp.
    this.anisotropy = 1;
    this.setFilteringAnisotropy(anisotropy);
    this.needsUpdate = true;
  }

  setFilteringAnisotropy(anisotropy: number) {
    this.coverAnisotropy.value = Math.min(4, Math.max(1, anisotropy));
    if (this.anisotropy !== 1) {
      this.anisotropy = 1;
      this.needsUpdate = true;
    }
  }

  setTile(slot: number, levels: CoverMip[]) {
    if (slot < 0 || slot >= this.columns * this.rows || levels.length !== this.mipmaps.length)
      throw new Error("Invalid cover tile or mip chain");
    for (let level = 0; level < levels.length; level++) {
      const source = levels[level], target = this.mipmaps[level], size = source.width;
      if (size !== this.tileSize / 2 ** level || source.height !== size)
        throw new Error("Cover mip dimensions do not match the atlas");
      const x = (slot % this.columns) * size, bottom = (this.rows - 1 - Math.floor(slot / this.columns)) * size;
      for (let y = 0; y < size; y++) {
        const offset = ((bottom + size - 1 - y) * target.width + x) * 4;
        target.data.set(source.data.subarray(y * size * 4, (y + 1) * size * 4), offset);
      }
    }
    // The CPU levels stay complete for the first upload and a restored context.
    // Afterwards only this tile is sent: a whole 432-slot atlas is ~150 MB.
    this.markDirty(slot);
    if (this.columns * this.rows === 1) this.coverMinLod.value = 0;
  }

  /**
   * Interim art for a single print: copy a smaller atlas tile into this
   * texture's matching coarser levels, and sample only those levels until the
   * full chain arrives. Avoids both a blank print and another album's art.
   */
  setLevelsFrom(atlas: CoverMipTexture, tile: number) {
    const offset = Math.log2(this.tileSize / atlas.tileSize);
    if (this.columns * this.rows !== 1 || !Number.isInteger(offset) || offset < 0)
      throw new Error("Interim levels need a single print at least as large as the atlas tile");
    const x = (tile % atlas.columns), row = atlas.rows - 1 - Math.floor(tile / atlas.columns);
    for (let level = 0; level < atlas.mipmaps.length; level++) {
      const source = atlas.mipmaps[level], size = atlas.tileSize / 2 ** level, target = this.mipmaps[level + offset].data;
      for (let y = 0; y < size; y++) {
        const from = ((row * size + y) * source.width + x * size) * 4;
        target.set(source.data.subarray(from, from + size * 4), y * size * 4);
      }
    }
    this.coverMinLod.value = offset;
    this.markDirty(0);
  }

  /**
   * A texture with another row count, keeping the tiles that fit unless
   * `keep` is false. Uniform objects are shared, so prints compiled against
   * this texture follow the new one.
   */
  resized(rows: number, keep = true) {
    const next = new CoverMipTexture(this.columns, rows, this.tileSize);
    Object.assign(next, { coverAnisotropy: this.coverAnisotropy, coverScale: this.coverScale, coverMinLod: this.coverMinLod });
    const kept = keep ? Math.min(this.rows, rows) : 0;
    for (let level = 0; level < this.mipmaps.length; level++) {
      const size = this.tileSize / 2 ** level, from = this.mipmaps[level], to = next.mipmaps[level];
      // Tile row r is stored bottom-up: its texel rows move with the row count.
      for (let row = 0; row < kept; row++) {
        const source = (this.rows - 1 - row) * size * from.width * 4, target = (rows - 1 - row) * size * to.width * 4;
        to.data.set(from.data.subarray(source, source + size * from.width * 4), target);
      }
    }
    CoverMipTexture.revision++;
    return next;
  }

  /** Same-sized copy for a returning snapshot; no repainting or mip rebuild. */
  copyFrom(source: CoverMipTexture) {
    if (source.columns !== this.columns || source.rows !== this.rows || source.tileSize !== this.tileSize)
      throw new Error("Cover textures differ in layout");
    for (let level = 0; level < this.mipmaps.length; level++) this.mipmaps[level].data.set(source.mipmaps[level].data);
    this.coverScale.value.copy(source.coverScale.value);
    this.coverMinLod.value = source.coverMinLod.value;
    for (let tile = 0; tile < this.columns * this.rows; tile++) this.markDirty(tile);
  }

  private markDirty(tile: number) {
    this.dirtyTiles.add(tile);
    CoverMipTexture.revision++;
  }

  /** Upload changed tiles before the texture is sampled. Called from the print's onBeforeRender. */
  flush(renderer: THREE.WebGLRenderer) {
    if (!this.dirtyTiles.size) return;
    const uploaded = renderer.properties.get(this) as { __version?: number; __webglTexture?: WebGLTexture };
    // Not on the GPU yet (or a full upload is pending): three sends every level.
    if (uploaded.__version === this.version && uploaded.__webglTexture) {
      // Direct sub-image uploads. three's copyTextureToTexture reads five pixel
      // store values back per call; each read waits for the GPU process, which
      // made a nine-level tile stall the frame instead of streaming.
      const gl = renderer.getContext() as WebGL2RenderingContext;
      renderer.state.bindTexture(gl.TEXTURE_2D, uploaded.__webglTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, this.flipY);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, this.premultiplyAlpha);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, this.unpackAlignment);
      for (const slot of this.dirtyTiles) {
        for (let level = 0; level < this.mipmaps.length; level++) {
          const size = this.tileSize / 2 ** level, image = this.mipmaps[level];
          const x = (slot % this.columns) * size, y = (this.rows - 1 - Math.floor(slot / this.columns)) * size;
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, image.width);
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
          gl.texSubImage2D(gl.TEXTURE_2D, level, x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, image.data);
        }
      }
      // three assumes the defaults for every other upload.
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      renderer.state.unbindTexture();
    }
    this.dirtyTiles.clear();
  }
}

const coverCenter = new THREE.Vector2(MUSIC_COVER.x, MUSIC_COVER.y);

/** Map replacement shared by instances, selection and returning snapshots. */
export function filterCoverShader(shader: THREE.WebGLProgramParametersWithUniforms, texture: CoverMipTexture, instanced: boolean) {
  shader.uniforms.coverTileSize = { value: texture.tileSize };
  shader.uniforms.coverMaxLod = { value: texture.mipmaps.length - 1 };
  // Keep the uniform object on the texture so quality changes update compiled
  // materials without rebuilding their program or re-uploading the mip chain.
  shader.uniforms.coverAnisotropy = texture.coverAnisotropy;
  shader.uniforms.coverMinLod = texture.coverMinLod;
  shader.uniforms.coverCenter = { value: coverCenter };
  // The art fills its texture tile; the quad itself takes the art's aspect, so
  // the visible cover border is real geometry (multisampled), not an alpha cut.
  if (instanced) {
    shader.vertexShader = "attribute vec4 coverTile;\nattribute vec2 coverScale;\nvarying vec4 vCoverTile;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <uv_vertex>", "#include <uv_vertex>\nvCoverTile = coverTile;");
    shader.fragmentShader = "varying vec4 vCoverTile;\n" + shader.fragmentShader;
  } else {
    shader.uniforms.coverScale = texture.coverScale;
    shader.vertexShader = "uniform vec2 coverScale;\n" + shader.vertexShader;
  }
  shader.vertexShader = "uniform vec2 coverCenter;\n" + shader.vertexShader.replace(
    "#include <begin_vertex>",
    "#include <begin_vertex>\ntransformed.xy = coverCenter + (transformed.xy - coverCenter) * coverScale;",
  );
  shader.fragmentShader = `
uniform float coverTileSize;
uniform float coverMaxLod;
uniform float coverAnisotropy;
uniform float coverMinLod;
vec4 coverLevel(sampler2D image, vec2 uv, vec4 tile, float level) {
  float inset = 0.5 * exp2(level) / coverTileSize;
  vec2 local = clamp(uv, vec2(inset), vec2(1.0 - inset));
  return textureLod(image, tile.xy + local * tile.zw, level);
}
vec4 coverTrilinear(sampler2D image, vec2 uv, vec4 tile, float lod) {
  float low = floor(lod), high = min(low + 1.0, coverMaxLod);
  vec4 value = coverLevel(image, uv, tile, low);
  if (lod > low) value = mix(value, coverLevel(image, uv, tile, high), lod - low);
  return value;
}
vec4 filteredCover(sampler2D image, vec2 uv, vec4 tile) {
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  float xLength = length(dx), yLength = length(dy);
  vec2 major = xLength >= yLength ? dx : dy;
  float majorLength = max(xLength, yLength) * coverTileSize;
  float minorLength = abs(dx.x * dy.y - dx.y * dy.x) * coverTileSize * coverTileSize / max(majorLength, 1e-6);
  float footprint = max(1.0, max(minorLength, majorLength / coverAnisotropy));
  float lod = clamp(log2(footprint), coverMinLod, coverMaxLod);
  // Four fixed positions avoid a tap-count discontinuity as the camera moves.
  // The span continuously becomes zero for isotropic or magnified artwork.
  vec2 span = major * max(0.0, 1.0 - footprint / max(majorLength, 1e-6));
  vec4 value = vec4(0.0);
  if (majorLength <= footprint) {
    value = coverTrilinear(image, uv, tile, lod);
  } else {
    for (int i = 0; i < 4; i++)
      value += coverTrilinear(image, uv + (float(i) / 3.0 - 0.5) * span, tile, lod) * 0.25;
  }
  // Stored RGB is sRGB-encoded, premultiplied *linear* colour. The sRGB texture
  // decodes before filtering; restore straight RGB for the existing Lambert ink.
  value.rgb = value.a > 0.0 ? value.rgb / value.a : vec3(0.0);
  return value;
}
` + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `
#ifdef USE_MAP
  diffuseColor *= filteredCover(map, vMapUv, ${instanced ? "vCoverTile" : "vec4(0.0, 0.0, 1.0, 1.0)"});
#endif
`);
}
