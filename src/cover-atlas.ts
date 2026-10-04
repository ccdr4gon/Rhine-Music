import * as THREE from "three";
import type { MusicSelectionLighting } from "./music-lighting";
import type { ArchiveRecord } from "./data";
import { MUSIC_COVER, createAlbumPrintMaterial } from "./music-model.ts";
import { CoverMipTexture, filterCoverShader } from "./cover-filtering.ts";
import { COVER_PAINT_SIZE } from "./cover-paint.ts";
import { CoverTiles, sizedCoverUrl, type CoverRequest } from "./cover-tiles.ts";
import type { CoverTint } from "./cover-tint.ts";
export { COVER_INSET, containCover, coverArtScale } from "./cover-paint.ts";

// Print on the glass surface. No transmitting/frosted layer sits over the image.
export const COVER_SIZE = MUSIC_COVER;

type Tile = { key: string; scale: [number, number]; tint?: CoverTint; ready: boolean; refs: number; used: number; request?: number };

/**
 * One atlas for the visible pool, regardless of total library size. Tiles are
 * addressed by content: every slot showing the same album points at one tile,
 * so the looping shelf re-shows known covers without repainting. The atlas
 * holds as many tile rows as the library can show at once (a 432-slot pool of
 * 256 px tiles is ~150 MB in memory and again on the GPU; three albums need one
 * row), and grows if more distinct covers ever appear.
 */
export class CoverAtlas {
  readonly array: THREE.InstancedMesh;
  readonly selected: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  /**
   * The colour each case's index square takes from its cover, per drawn instance like the
   * print attributes (the shelf's hardware batch draws with it): linear RGB and a weight,
   * which is zero while the case shows no art and the square keeps its own amber.
   */
  readonly caseTint: THREE.InstancedBufferAttribute;
  /** The same for the lifted case: it follows the lifted print. */
  readonly selectedTint = new THREE.Vector4(0, 0, 0, 0);
  private atlas: CoverMipTexture;
  private readonly selectedTexture: CoverMipTexture;
  private readonly tileRect: THREE.InstancedBufferAttribute;
  private readonly artScale: THREE.InstancedBufferAttribute;
  private tiles: (Tile | undefined)[];
  private readonly tileOfKey = new Map<string, number>();
  private readonly slotKeys: (string | undefined)[];
  private readonly slotTile: Int32Array;
  // Per pool slot: tile rectangle and art scale. The instanced attributes hold them in
  // draw order (see order()), which the shelf repacks as cases enter and leave the view.
  private readonly slotRect: Float32Array;
  private readonly slotScale: Float32Array;
  private readonly slotTint: Float32Array;
  private readonly shownSlots: Int32Array;
  private shownCount = -1;
  private slotsChanged = true;
  private readonly recordKeys = new WeakMap<ArchiveRecord, string>();
  private selectedRecord?: ArchiveRecord;
  private selectedKey?: string;
  private selectedRequest?: number;
  private generation = 0;
  private clock = 0;
  private disposed = false;
  private readonly columns = 16;
  private rows = 1;
  private readonly maxRows: number;
  private readonly tileWidth: number;

  constructor(
    count: number,
    maxTextureSize: number,
    anisotropy: number,
    lighting?: MusicSelectionLighting,
    private readonly painter: Pick<CoverTiles, "render" | "cancel" | "dispose"> = new CoverTiles(),
  ) {
    this.maxRows = Math.ceil(count / this.columns);
    const tileLimit = Math.min(
      256,
      Math.floor(maxTextureSize / this.columns),
      Math.floor(maxTextureSize / this.maxRows),
    );
    this.tileWidth = 2 ** Math.floor(Math.log2(Math.max(1, tileLimit)));
    this.tiles = Array(this.columns * this.rows);
    this.slotKeys = Array(count);
    this.slotTile = new Int32Array(count).fill(-1);
    this.slotRect = new Float32Array(count * 4);
    this.slotScale = new Float32Array(count * 2);
    this.slotTint = new Float32Array(count * 4);
    this.shownSlots = new Int32Array(count);
    this.atlas = new CoverMipTexture(this.columns, this.rows, this.tileWidth, anisotropy);
    this.selectedTexture = new CoverMipTexture(1, 1, COVER_PAINT_SIZE, anisotropy);
    this.selectedTexture.coverScale.value.set(0, 0);
    const geometry = new THREE.PlaneGeometry(
      COVER_SIZE.width,
      COVER_SIZE.height,
    ).translate(COVER_SIZE.x, COVER_SIZE.y, COVER_SIZE.z);
    // Per slot: which tile it shows, and the art's aspect (zero hides the print
    // while its tile is still being prepared; never another album's art).
    this.tileRect = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.tileRect.setUsage(THREE.DynamicDrawUsage);
    this.artScale = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2);
    this.artScale.setUsage(THREE.DynamicDrawUsage);
    this.caseTint = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.caseTint.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("coverTile", this.tileRect);
    geometry.setAttribute("coverScale", this.artScale);
    // Instances, selected art and snapshots use one matte diffuse material and
    // one moving light field; no ownership-specific brightness/scale switches.
    const makePrint = (texture: CoverMipTexture, instanced = false) => {
      const print = createAlbumPrintMaterial(texture);
      const compile = print.onBeforeCompile;
      print.onBeforeCompile = function (this: THREE.MeshLambertMaterial, shader, renderer) {
        compile.call(this, shader, renderer);
        lighting?.shadePrint(shader, this.userData.musicCard);
        filterCoverShader(shader, this.map as CoverMipTexture, instanced);
      };
      print.onBeforeRender = function (this: THREE.MeshLambertMaterial, renderer) {
        (this.map as CoverMipTexture).flush(renderer);
      };
      print.customProgramCacheKey = () => `album-filtered-print-${instanced}-${Boolean(lighting)}-v7`;
      // The lifted print's share of the song scene's large card; a copy made of this material
      // (snapshot) gets its own through the clone. Shelf prints have none.
      if (!instanced) print.userData.musicCard = { value: 0 };
      return print;
    };
    const material = makePrint(this.atlas, true);
    this.array = new THREE.InstancedMesh(geometry, material, count);
    this.array.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.array.frustumCulled = false;
    this.array.visible = false;
    this.array.name = "Album cover atlas";
    this.array.receiveShadow = true;
    this.selected = new THREE.Mesh(
      new THREE.PlaneGeometry(COVER_SIZE.width, COVER_SIZE.height).translate(
        COVER_SIZE.x,
        COVER_SIZE.y,
        COVER_SIZE.z,
      ),
      makePrint(this.selectedTexture),
    );
    this.selected.userData.albumCover = true;
    this.selected.visible = false;
    this.selected.name = "Selected album cover";
    this.selected.receiveShadow = true;
  }

  /** Changes whenever any print's art or its slot assignment changes. */
  get revision() {
    return CoverMipTexture.revision + this.tileRect.version + this.artScale.version + this.caseTint.version;
  }

  /** Visual identity only: metadata refreshes replace records without changing their print. */
  private keyOf(record: ArchiveRecord | undefined) {
    if (!record) return "";
    let key = this.recordKeys.get(record);
    if (key === undefined) {
      key = JSON.stringify([record.id, record.album?.coverUrl, record.title]);
      this.recordKeys.set(record, key);
    }
    return key;
  }

  private request(record: ArchiveRecord | undefined, size: number, priority = false) {
    const full = record?.album?.coverUrl, url = sizedCoverUrl(full, size);
    const request: CoverRequest = {
      size,
      url,
      fallbackUrl: url === full ? undefined : full,
      title: record?.title,
      external: record?.id.startsWith("external:"),
      priority,
    };
    return this.painter.render(request);
  }

  setSlot(slot: number, record: ArchiveRecord | undefined) {
    const key = this.keyOf(record);
    if (this.slotKeys[slot] === key) return;
    this.release(slot);
    this.slotKeys[slot] = key;
    const tile = this.tileOfKey.get(key) ?? this.allocate(key, record);
    this.tiles[tile]!.refs++;
    this.slotTile[slot] = tile;
    this.writeSlot(slot);
  }

  private release(slot: number) {
    const index = this.slotTile[slot];
    this.slotTile[slot] = -1;
    const tile = index >= 0 ? this.tiles[index] : undefined;
    if (!tile) return;
    tile.refs--;
    tile.used = ++this.clock;
    // Nobody waits for this tile any more: drop its queued work and its slot.
    if (tile.refs === 0 && !tile.ready) {
      if (tile.request !== undefined) this.painter.cancel(tile.request);
      this.tileOfKey.delete(tile.key);
      this.tiles[index] = undefined;
    }
  }

  private allocate(key: string, record: ArchiveRecord | undefined) {
    let index = this.tiles.findIndex((tile) => tile === undefined);
    if (index < 0 && this.rows < this.maxRows) {
      this.resize(Math.min(this.maxRows, this.rows * 2));
      index = this.tiles.findIndex((tile) => tile === undefined);
    }
    if (index < 0) {
      // At most one tile per slot is referenced, so a full-size atlas always has a free one.
      let oldest = Infinity;
      this.tiles.forEach((tile, i) => {
        if (tile && tile.refs === 0 && tile.used < oldest) {
          oldest = tile.used;
          index = i;
        }
      });
      if (index < 0) throw new Error("Cover atlas invariant: every tile is in use");
      this.tileOfKey.delete(this.tiles[index]!.key);
    }
    const tile: Tile = { key, scale: [0, 0], ready: false, refs: 0, used: ++this.clock };
    // The lifted case of this album already shows its sharp print (at start-up it is
    // selected before any slot shows it): the shelf takes that print's colour.
    if (key === this.selectedKey && this.selectedRequest === undefined && this.selectedTint.w > 0)
      tile.tint = [this.selectedTint.x, this.selectedTint.y, this.selectedTint.z];
    this.tiles[index] = tile;
    this.tileOfKey.set(key, index);
    const generation = this.generation;
    const { id, tile: painted } = this.request(record, this.tileWidth);
    tile.request = id;
    void painted.then((art) => {
      if (!art || this.disposed || generation !== this.generation || this.tiles[index] !== tile) return;
      this.atlas.setTile(index, art.levels);
      tile.scale = art.scale;
      // The sharp print of a lifted case can arrive first; its colour then stays, unless
      // this paint found no art: a missing-cover print carries no colour.
      tile.tint = art.tint && (tile.tint ?? art.tint);
      tile.ready = true;
      tile.request = undefined;
      for (let slot = 0; slot < this.slotTile.length; slot++) if (this.slotTile[slot] === index) this.writeSlot(slot);
      // A lifted print that is still waiting for its sharp chain can show this tile meanwhile.
      if (this.selectedKey === key && this.selectedRequest !== undefined && this.selectedTexture.coverScale.value.x === 0)
        this.showInterimSelection(index);
    });
    return index;
  }

  /** Change the atlas to this many tile rows, keeping the tiles that fit unless told not to. */
  private resize(rows: number, keep = true) {
    if (rows === this.rows) return;
    const next = this.atlas.resized(rows, keep);
    this.atlas.dispose();
    this.atlas = next;
    (this.array.material as THREE.MeshLambertMaterial).map = next;
    this.rows = rows;
    this.tiles.length = this.columns * rows;
    for (let slot = 0; slot < this.slotTile.length; slot++) if (this.slotTile[slot] >= 0) this.writeSlot(slot);
  }

  private writeSlot(slot: number) {
    const index = this.slotTile[slot], tile = this.tiles[index];
    this.slotRect[slot * 4] = (index % this.columns) / this.columns;
    this.slotRect[slot * 4 + 1] = 1 - (Math.floor(index / this.columns) + 1) / this.rows;
    this.slotRect[slot * 4 + 2] = 1 / this.columns;
    this.slotRect[slot * 4 + 3] = 1 / this.rows;
    // Art and quad change in the same frame: the tile uploads before the
    // next atlas draw, and these attributes upload with that draw.
    this.slotScale[slot * 2] = tile?.ready ? tile.scale[0] : 0;
    this.slotScale[slot * 2 + 1] = tile?.ready ? tile.scale[1] : 0;
    // The square takes its colour in the frame its cover appears.
    const tint = tile?.ready ? tile.tint : undefined;
    for (let k = 0; k < 3; k++) this.slotTint[slot * 4 + k] = tint ? tint[k] : 0;
    this.slotTint[slot * 4 + 3] = tint ? 1 : 0;
    this.slotsChanged = true;
  }

  /**
   * Lay the slots' prints out in draw order: instance i shows slot slots[i]. Rewrites
   * and uploads the attributes only when the order or a slot's print changed, so a
   * still shelf keeps a stable revision.
   */
  order(slots: Int32Array, count: number) {
    let changed = this.slotsChanged || count !== this.shownCount;
    for (let i = 0; i < count && !changed; i++) changed = this.shownSlots[i] !== slots[i];
    if (!changed) return;
    const rect = this.tileRect.array as Float32Array, scale = this.artScale.array as Float32Array;
    const tint = this.caseTint.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const slot = slots[i];
      this.shownSlots[i] = slot;
      for (let k = 0; k < 4; k++) rect[i * 4 + k] = this.slotRect[slot * 4 + k];
      for (let k = 0; k < 4; k++) tint[i * 4 + k] = this.slotTint[slot * 4 + k];
      scale[i * 2] = this.slotScale[slot * 2];
      scale[i * 2 + 1] = this.slotScale[slot * 2 + 1];
    }
    this.shownCount = count;
    this.slotsChanged = false;
    for (const attribute of [this.tileRect, this.artScale, this.caseTint]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  private showInterimSelection(index: number) {
    this.selectedTexture.setLevelsFrom(this.atlas, index);
    this.selectedTexture.coverScale.value.set(...this.tiles[index]!.scale);
    this.writeTint(this.selectedTint, this.tiles[index]!.tint);
  }

  private writeTint(target: THREE.Vector4, tint: CoverTint | undefined) {
    if (tint) target.set(tint[0], tint[1], tint[2], 1);
    else target.set(0, 0, 0, 0);
  }

  /**
   * The colour that goes with a sharp print. The shelf tile of the same album decides when it
   * is painted, so a case keeps one colour between the shelf and the lifted position (the two
   * paint sizes differ by about 1%); a tile still waiting takes this print's colour. A print
   * painted without art (a failed load) has no colour, whatever the other size found.
   */
  private tintWith(key: string | undefined, art: { tint?: CoverTint }) {
    if (!art.tint) return undefined;
    const index = key === undefined ? undefined : this.tileOfKey.get(key);
    const tile = index === undefined ? undefined : this.tiles[index];
    if (!tile) return art.tint;
    if (!tile.ready) tile.tint ??= art.tint;
    return tile.tint ?? art.tint;
  }

  async select(record: ArchiveRecord | undefined) {
    this.selectedRecord = record;
    const key = this.keyOf(record);
    this.selectedKey = key;
    if (this.selectedRequest !== undefined) this.painter.cancel(this.selectedRequest);
    // Show the shelf's tile at once (coarser levels only), then the sharp print.
    const index = this.tileOfKey.get(key);
    if (index !== undefined && this.tiles[index]!.ready) this.showInterimSelection(index);
    else {
      this.selectedTexture.coverScale.value.set(0, 0);
      this.selectedTint.set(0, 0, 0, 0);
    }
    const generation = this.generation;
    const { id, tile } = this.request(record, COVER_PAINT_SIZE, true);
    this.selectedRequest = id;
    const art = await tile;
    if (!art || this.disposed || generation !== this.generation || this.selectedRequest !== id) return;
    this.selectedRequest = undefined;
    this.selectedTexture.setTile(0, art.levels);
    this.selectedTexture.coverScale.value.set(...art.scale);
    this.writeTint(this.selectedTint, this.tintWith(key, art));
  }

  /** `tint` receives the copy's index-square colour, which stays with the print it shows. */
  snapshot(mesh: THREE.Mesh, tint?: THREE.Vector4) {
    // The returning copy keeps the print it already shows: copy the prepared
    // levels instead of repainting and rebuilding a 1024 px chain.
    const texture = new CoverMipTexture(1, 1, COVER_PAINT_SIZE, this.selectedTexture.coverAnisotropy.value);
    texture.copyFrom(this.selectedTexture);
    mesh.material = this.selected.material.clone();
    mesh.material.onBeforeCompile = this.selected.material.onBeforeCompile;
    mesh.material.onBeforeRender = this.selected.material.onBeforeRender;
    mesh.material.customProgramCacheKey = this.selected.material.customProgramCacheKey;
    (mesh.material as THREE.MeshLambertMaterial).map = texture;
    mesh.userData.coverDisposed = false;
    tint?.copy(this.selectedTint);
    if (this.selectedRequest === undefined) return;
    // The sharp print was still being prepared: finish it for the copy too.
    const key = this.selectedKey;
    const { tile } = this.request(this.selectedRecord, COVER_PAINT_SIZE, true);
    void tile.then((art) => {
      if (!art || mesh.userData.coverDisposed || this.disposed) return;
      texture.setTile(0, art.levels);
      texture.coverScale.value.set(...art.scale);
      if (tint) this.writeTint(tint, this.tintWith(key, art));
    });
  }

  /** Forget every print. `albums` sizes the atlas for the library about to be shown. */
  reset(albums = Infinity) {
    this.generation++;
    for (const tile of this.tiles) if (tile?.request !== undefined) this.painter.cancel(tile.request);
    if (this.selectedRequest !== undefined) this.painter.cancel(this.selectedRequest);
    this.tiles.fill(undefined);
    this.tileOfKey.clear();
    this.slotKeys.fill(undefined);
    this.slotTile.fill(-1);
    // Sized up front, so browsing never stops to upload a larger atlas.
    this.resize(Math.min(this.maxRows, Math.max(1, Math.ceil(albums / this.columns))), false);
    (this.artScale.array as Float32Array).fill(0);
    this.artScale.needsUpdate = true;
    this.slotScale.fill(0);
    (this.caseTint.array as Float32Array).fill(0);
    this.caseTint.needsUpdate = true;
    this.slotTint.fill(0);
    this.selectedTint.set(0, 0, 0, 0);
    this.slotsChanged = true;
    this.selectedRecord = this.selectedKey = this.selectedRequest = undefined;
    this.selectedTexture.coverScale.value.set(0, 0);
  }
  dispose() {
    this.disposed = true;
    this.painter.dispose();
    this.atlas.dispose();
    this.selectedTexture.dispose();
    this.array.geometry.dispose();
    (this.array.material as THREE.Material).dispose();
    this.selected.geometry.dispose();
    this.selected.material.dispose();
  }
}
