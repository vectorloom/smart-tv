import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { firstPage, hasFirstPage, type AlbumsState } from './albums';
import { imageUrl, type Album, type Photo } from './api';
import { ChevronIcon } from './icons';

export const ROW_PHOTOS = 12;
/** At most this many album rows; further albums are listed as plain buttons below them. */
export const MAX_ROWS = 20;
/** Rows within this distance of the focused row load and show thumbnails; the rest stay light. */
export const NEAR_ROWS = 2;

function Thumb({ album, photo, show, onOpen }: { album: Album; photo: Photo; show: boolean; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  return <button className="thumb" data-focus-key={`photo:${album.id}:${photo.id}`} aria-label={`Open ${photo.name}`} onClick={onOpen}>
    {show && !failed && <img src={imageUrl(album.id, photo.id)} alt="" loading="lazy" onError={() => setFailed(true)} />}
  </button>;
}

function AlbumRow({ album, index, near, onOpenAlbum, onOpenPhoto }: {
  album: Album; index: number; near: boolean; onOpenAlbum: (album: Album) => void; onOpenPhoto: (album: Album, photo: Photo) => void;
}) {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  // A placeholder that had focus when the photos arrived hands focus to the photo in its slot.
  const handOff = useRef<number | null>(null);
  // Fetch when the row comes near the focus (or the list is already cached, e.g. coming Back here).
  const wanted = near || hasFirstPage(album.id);
  useEffect(() => {
    if (!wanted || photos || failed) return;
    const controller = new AbortController();
    firstPage(album.id, controller.signal)
      .then(page => {
        const slot = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-slot]');
        handOff.current = slot && strip.current?.contains(slot) ? Number(slot.dataset.slot) : null;
        setPhotos(page.items.slice(0, ROW_PHOTOS));
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [album.id, wanted, photos, failed]);
  useLayoutEffect(() => {
    if (handOff.current === null || !strip.current) return;
    const tiles = [...strip.current.querySelectorAll<HTMLElement>('button.thumb')];
    (tiles[Math.min(handOff.current, tiles.length - 1)])?.focus();
    handOff.current = null;
  }, [photos, failed]);
  // Rows that have not loaded yet keep focusable placeholders, so holding Down never skips a row.
  const slots = Math.max(1, Math.min(6, album.assetCount));
  return <section className="photo-row" data-row={index} aria-label={album.name} aria-busy={near && photos === null && !failed}>
    <h2 className="row-title"><span>{album.name}</span><span className="row-count">{album.assetCount.toLocaleString('en-US')} photos</span></h2>
    <div className="row-strip" ref={strip}>
      {photos === null && !failed && Array.from({ length: slots }, (_, i) =>
        <button className="thumb is-placeholder" key={i} data-slot={i} aria-label={`Loading ${album.name}`} />)}
      {failed && <p className="row-message">These photos could not be loaded.</p>}
      {/* Far rows keep their buttons (so remembered focus can return) but drop the images. */}
      {photos?.map(photo => <Thumb key={photo.id} album={album} photo={photo} show={near} onOpen={() => onOpenPhoto(album, photo)} />)}
      <button className="thumb see-all" data-focus-key={`album:${album.id}:all`} onClick={() => onOpenAlbum(album)}>
        <span>See all</span><ChevronIcon />
      </button>
    </div>
  </section>;
}

/** /photos — one horizontal row per album. Up/Down moves between rows, Left/Right along a row. */
export function PhotosScreen({ albums, onOpenAlbum, onOpenPhoto }: {
  albums: AlbumsState; onOpenAlbum: (album: Album) => void; onOpenPhoto: (album: Album, photo: Photo) => void;
}) {
  const { albums: list, loading, error, retry } = albums;
  const [focusedRow, setFocusedRow] = useState(0);
  const rows = list.slice(0, MAX_ROWS);
  const more = list.slice(MAX_ROWS);
  return <main className="screen-page photos-screen" aria-busy={loading && !list.length}
    onFocus={event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row]')?.dataset.row;
      if (row !== undefined) setFocusedRow(Number(row));
      else if ((event.target as HTMLElement).closest('.more-albums')) setFocusedRow(rows.length);
    }}>
    <header className="screen-header">
      <h1>Photos</h1>
      <p className="screen-sub">{loading && !list.length ? 'Loading albums…' : `${list.length} ${list.length === 1 ? 'album' : 'albums'}`}</p>
    </header>
    {error && !list.length && <div className="notice" role="alert">
      <h2>Albums are unavailable</h2><p>{error} Retrying automatically.</p>
      <button className="pill" data-autofocus onClick={retry}>Try again</button>
    </div>}
    {!loading && !error && !list.length && <div className="notice">
      <h2>No albums yet</h2><p>Select albums in the administrator settings.</p>
    </div>}
    {rows.map((album, index) => <AlbumRow key={album.id} album={album} index={index} near={Math.abs(index - focusedRow) <= NEAR_ROWS}
      onOpenAlbum={onOpenAlbum} onOpenPhoto={onOpenPhoto} />)}
    {more.length > 0 && <section className="more-albums" aria-label="More albums">
      <h2 className="row-title"><span>More albums</span><span className="row-count">{more.length.toLocaleString('en-US')}</span></h2>
      <div className="more-list">
        {more.map(album => <button className="pill" key={album.id} data-focus-key={`album:${album.id}:all`} onClick={() => onOpenAlbum(album)}>
          <span>{album.name}</span><span className="row-count">{album.assetCount.toLocaleString('en-US')}</span>
        </button>)}
      </div>
    </section>}
  </main>;
}
