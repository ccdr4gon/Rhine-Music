/** JSON contract shared by the local music service and the visual interface. */
export interface MusicTrack {
  id: string;
  albumId: string;
  title: string;
  artist: string;
  trackNumber?: number;
  discNumber?: number;
  duration: number;
  format: string;
  codec?: string;
  bitsPerSample?: number;
  sampleRate?: number;
  bitrate?: number;
  numberOfChannels?: number;
  lossless?: boolean;
  browserPlayable: boolean;
  audioUrl: string;
  relativePath: string;
  /** The song's own album tag, when it has one (its album record may hold other songs too). */
  album?: string;
  /** The song's own year tag, when it has one. */
  year?: number;
}

export interface MusicProducer {
  name: string;
  role: string;
  source: "local" | "MusicBrainz" | "manual";
  trackTitle?: string;
  url?: string;
}

export interface MusicAlbum {
  id: string;
  title: string;
  artist: string;
  year?: number;
  discCount?: number;
  description?: string;
  descriptionSource?: {
    name: string;
    url: string;
    checkedAt?: string;
    license?: string;
  };
  localNote?: string;
  introduction?: {
    status: "unqueried" | "matched" | "not-found" | "uncertain" | "error";
    checkedAt?: string;
    error?: string;
    candidateUrl?: string;
  };
  genreId: string;
  rawGenres: string[];
  folder: string;
  coverUrl?: string;
  /**
   * The picture, where its address can change while the picture does not (NetEase serves one
   * picture from any of its image servers): the covers and the shelf compare cases by it. The
   * address otherwise.
   */
  coverKey?: string;
  tracks: MusicTrack[];
  producers: MusicProducer[];
  offline: boolean;
  online?: {
    status: "unqueried" | "matched" | "uncertain" | "not-found" | "error";
    releaseId?: string;
    releaseGroupId?: string;
    checkedAt?: string;
    sourceUrl?: string;
    error?: string;
    descriptionStatus?: "available" | "not-found" | "error";
    descriptionError?: string;
  };
}

export interface MusicGenre {
  id: string;
  name: string;
  aliases?: string[];
  albumCount?: number;
}

export interface GenreRules {
  version: 1;
  genres: MusicGenre[];
  albumOverrides: Record<string, string>;
}

export interface LibraryRoot {
  path: string;
  status: "online" | "offline" | "unscanned";
  error?: string;
  /** QQ Music's encrypted downloads (.mflac, .mgg, .qmc*) seen by the last scan: never read. */
  encrypted?: number;
  /**
   * Songs and folders the last scan could not read (in use, not permitted, a name that is not valid
   * Unicode): a known song kept its record, a folder its albums (offline); new ones wait.
   */
  unreadable?: number;
}

/**
 * One playlist of the main folder (the owner, 2026-10-06: "Local music means choosing a main
 * folder, and each playlist will be a subfolder"): a direct subfolder with its songs at any depth,
 * or the main folder's own songs, listed first and named after the main folder.
 */
export interface MusicPlaylist {
  id: string;
  name: string;
  /** The playlist's folder: the subfolder, or the main folder itself. */
  folder: string;
  /** The main folder's own songs rather than a subfolder. */
  main: boolean;
  /** The songs (track IDs) in natural order of their paths inside the main folder. */
  trackIds: string[];
}

export interface MusicLibrary {
  version: 1;
  albums: MusicAlbum[];
  genres: MusicGenre[];
  /** The local library's columns: the main folder's playlists (the first of `roots`). */
  playlists?: MusicPlaylist[];
  /** The main folder first; folders saved after it by earlier versions are kept but unused. */
  roots: LibraryRoot[];
  /** The names the data files this start could not read were set aside under (damaged or newer). */
  setAside?: string[];
  scan: {
    running: boolean;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  };
  onlineEnabled: boolean;
  enrich?: {
    running: boolean;
    completed: number;
    total: number;
    error?: string;
  };
  introductions?: {
    running: boolean;
    completed: number;
    total: number;
    updated: number;
    notFound: number;
    failed: number;
    currentAlbum?: string;
    error?: string;
  };
}
