type Track = { id: string; title: string; artist: string; album: string | null; artworkUrl: string | null; sourceLabel: string; sourceKey: string };
const validTrack = (row: unknown): row is Track => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const r=row as Record<string, unknown>;
  return ['id','title','artist','sourceLabel','sourceKey'].every(key=>typeof r[key]==='string') && Boolean(r.id)
    && (r.album===null || typeof r.album==='string') && (r.artworkUrl===null || typeof r.artworkUrl==='string');
};
type LibraryBody = {
  performerId: string;
  catalog: { tracks: Track[]; [key: string]: unknown };
  external: { tracks: Track[]; pagination: { offset: number; limit: number; version: string; hasMore: boolean; nextOffset: number | null }; [key: string]: unknown };
};
/** Read a coherent saved library, never quietly treating its first page as complete. */
export async function readRequestLibrary(options: {performerId: string; signal?: AbortSignal; fetcher?: typeof fetch}): Promise<LibraryBody> {
  const fetcher=options.fetcher ?? fetch;
  const signal=AbortSignal.any([...(options.signal ? [options.signal] : []),AbortSignal.timeout(60_000)]);
  let first: LibraryBody | null=null, offset=0, version='', pages=0;
  const tracks: Track[]=[], ids=new Set<string>();
  while(++pages<=1000) {
    if(signal.aborted) throw signal.reason;
    const query=offset ? '?'+new URLSearchParams({offset:String(offset),version}) : '';
    const response=await fetcher('/api/talent/library/tracks'+query,{cache:'no-store',signal});
    const data=await response.json().catch(()=>null) as LibraryBody | null;
    if(!response.ok) throw new Error(typeof (data as any)?.error==='string' ? (data as any).error : 'Could not load your music.');
    const page=data?.external?.pagination;
    if(!data || data.performerId!==options.performerId || !Array.isArray(data.catalog?.tracks) || !Array.isArray(data.external?.tracks)
      || !data.catalog.tracks.every(validTrack) || !data.external.tracks.every(validTrack)
      || !page || page.offset!==offset || page.limit!==100 || typeof page.version!=='string' || !/^[a-f0-9]{64}$/.test(page.version)
      || (version && page.version!==version) || typeof page.hasMore!=='boolean'
      || data.external.tracks.length>100 || (page.hasMore && (data.external.tracks.length!==100 || page.nextOffset!==offset+100))
      || (!page.hasMore && page.nextOffset!==null)) throw new Error('Your saved music could not be confirmed. Refresh Sources to try again.');
    first ??= data;version=page.version;
    for(const track of data.external.tracks) {
      if(!track || typeof track.id!=='string' || !track.id || ids.has(track.id)) throw new Error('Your library changed while loading. Refresh Sources to try again.');
      ids.add(track.id);tracks.push(track);
    }
    if(!page.hasMore) return {...first,external:{...first.external,tracks,pagination:{...page,offset:0,nextOffset:null,hasMore:false}}};
    offset=page.nextOffset!;
  }
  throw new Error('Your library is too large to finish loading in one view. No partial library was accepted.');
}
