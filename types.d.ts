// Shared shapes for Room Blend. Checked by `npm run typecheck`; nothing here runs.

/** A song the room can play. `id` is the room's own id; `nid` is the music service's own id (a Spotify uri or YouTube video id). */
interface Track {
  id: string;
  title: string;
  artist: string;
  genres: string[];
  nid?: string;
  /** Optional album artwork supplied by the connected music provider. */
  artwork?: string;
  /** Short list of genre tags the song is tagged with by the host's library or the service. */
  src?: string;
}

/** What a guest picked, in order: a genre name, or a group such as "any:rock". */
type GenrePick = string;

/** Genre name to how much a person likes it (0 to 1). */
type Taste = Record<string, number>;

/** A person who counts toward the blend right now. */
interface Person {
  id: string;
  taste: Taste;
  /** Normalised keys of artists this person named (see normKey). */
  artists?: string[];
  /** Keys of songs this person named (see songKey). */
  songs?: string[];
}

/** One slot in the queue and why it was chosen. */
interface QueueItem {
  track: Track;
  /** "blend": chosen for what the room shares. "rotate": one guest's turn. */
  mode: 'blend' | 'rotate';
  /** Guest whose turn it is, for mode "rotate"; otherwise null. */
  owner: string | null;
  /** How much airtime credit each person gets for this song. */
  credit: Record<string, number>;
  fits: Array<{ id: string; fit: number }>;
  /** Room score for this song. */
  room: number;
}

interface Catalog { version: number; tracks: Track[]; cache: Map<string, any>; keys?: Array<{ artists: Set<string>; song: string }>; }

interface BuildOptions {
  catalog: Catalog;
  /** Weight on the least-happy person, 0 to 1. */
  lambda?: number;
  /** Lowest room score that still counts as a blend. */
  tau?: number;
  /** Number of queue slots to fill. */
  n?: number;
  recentIds?: string[];
  recentArtists?: string[];
  /** Recent per-listener genre exposure counts used to carry balance across queue rebuilds. */
  genreHistory?: Record<string, Record<string, number>>;
  /** Airtime each person has had so far. */
  served?: Record<string, number>;
  keep?: Array<Pick<QueueItem, 'track' | 'mode' | 'owner'>>;
  lastPrimary?: string;
  prevPrimary?: string;
  seed?: number;
}

/** What a music source (Spotify, YouTube, the host's own files and so on) offers the host's browser. */
interface Provider {
  id: string;
  label: string;
  play(track: Track): Promise<any>;
  extras?(genre: string, partners: string[]): Promise<{ tracks: Track[]; pool: boolean }>;
}
