import { useEffect, useState } from 'react';
import { firstPage, type AlbumsState } from './albums';
import { imageUrl, type Album, type Photo } from './api';
import { ChevronIcon } from './icons';

export const ROW_PHOTOS = 12;

function Thumb({ album, photo, onOpen }: { album: Album; photo: Photo; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  return <button className="thumb" data-focus-key={`photo:${album.id}:${photo.id}`} aria-label={`Open ${photo.name}`} onClick={onOpen}>
    {!failed && <img src={imageUrl(album.id, photo.id)} alt="" loading="lazy" onError={() => setFailed(true)} />}
  </button>;
}

function AlbumRow({ album, onOpenAlbum, onOpenPhoto }: {
  album: Album; onOpenAlbum: (album: Album) => void; onOpenPhoto: (album: Album, photo: Photo) => void;
}) {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    firstPage(album.id, controller.signal)
      .then(page => setPhotos(page.items.slice(0, ROW_PHOTOS)))
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [album.id]);
  return <section className="photo-row" aria-label={album.name} aria-busy={photos === null && !failed}>
    <h2 className="row-title"><span>{album.name}</span><span className="row-count">{album.assetCount.toLocaleString('en-US')} photos</span></h2>
    <div className="row-strip">
      {photos === null && !failed && Array.from({ length: 6 }, (_, i) => <span className="thumb is-placeholder" key={i} aria-hidden="true" />)}
      {failed && <p className="row-message">These photos could not be loaded.</p>}
      {photos?.map(photo => <Thumb key={photo.id} album={album} photo={photo} onOpen={() => onOpenPhoto(album, photo)} />)}
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
  return <main className="screen-page photos-screen" aria-busy={loading && !list.length}>
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
    {list.map(album => <AlbumRow key={album.id} album={album} onOpenAlbum={onOpenAlbum} onOpenPhoto={onOpenPhoto} />)}
  </main>;
}
