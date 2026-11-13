import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useSearchParams } from 'react-router';
import { useAlbumPhotos, type AlbumsState } from './albums';
import { SCREEN_COMMAND } from './focus';
import { imageUrl, type Photo } from './api';
import { PlayIcon } from './icons';
import { Slideshow } from './Slideshow';
import { useStageElement } from './Stage';

const PAGE = 60;

/**
 * /photos/:albumId — every photo in the album. `?photo=<id>` opens the full-screen viewer, so Back,
 * Escape and the browser's back button all close it through history and focus returns to the photo.
 */
export function AlbumScreen({ albums, onOpenPhoto, onCloseViewer, onHome }: {
  albums: AlbumsState; onOpenPhoto: (albumId: string, photo: Photo) => void; onCloseViewer: () => void; onHome: () => void;
}) {
  const { albumId = '' } = useParams();
  const [search] = useSearchParams();
  const viewing = search.get('photo');
  const { photos, loading, error, retry } = useAlbumPhotos(albumId);
  const [visible, setVisible] = useState(PAGE);
  const stage = useStageElement();
  const album = albums.albums.find(item => item.id === albumId);
  const name = album?.name ?? (albums.loading ? 'Loading…' : 'Album');
  const viewerReady = viewing && photos.some(photo => photo.id === viewing);
  // The photo the viewer was opened on must be rendered, so focus can return to it on Back.
  const viewingIndex = viewing ? photos.findIndex(photo => photo.id === viewing) : -1;
  useEffect(() => {
    if (viewingIndex >= 0) setVisible(value => Math.max(value, Math.ceil((viewingIndex + 1) / PAGE) * PAGE));
  }, [viewingIndex]);

  // PlayPause on the remote plays the album from the start.
  const first = photos[0];
  useEffect(() => {
    if (viewing || !first || error) return;
    const play = (event: Event) => { if ((event as CustomEvent).detail === 'PlayPause') onOpenPhoto(albumId, first); };
    window.addEventListener(SCREEN_COMMAND, play);
    return () => window.removeEventListener(SCREEN_COMMAND, play);
  }, [viewing, first, error, albumId, onOpenPhoto]);

  return <main className="screen-page album-screen" aria-busy={loading && !photos.length && !error}>
    <header className="screen-header album-header">
      <div>
        <h1>{name}</h1>
        <p className="screen-sub">{photos.length.toLocaleString('en-US')} photos{loading ? ' · still loading' : ''}</p>
      </div>
      <button className="pill pill-primary" data-focus-key="play" data-autofocus disabled={!photos.length || !!error}
        onClick={() => onOpenPhoto(albumId, photos[0])}><PlayIcon />Play album</button>
    </header>
    {error && <div className="notice" role="alert">
      <h2>We couldn’t load this album</h2><p>{error}</p>
      <button className="pill" data-focus-key="retry" onClick={retry}>Try again</button>
    </div>}
    {!loading && !error && !photos.length && <div className="notice"><h2>No photos here yet</h2><p>This album has no available photos.</p></div>}
    <div className="thumb-grid">
      {photos.slice(0, visible).map(photo => <button className="thumb" key={photo.id} data-focus-key={`photo:${albumId}:${photo.id}`}
        aria-label={`Open ${photo.name}`} onClick={() => onOpenPhoto(albumId, photo)}>
        <img src={imageUrl(albumId, photo.id)} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }} />
      </button>)}
    </div>
    {visible < photos.length && <button className="pill load-more" data-focus-key="more" onClick={() => setVisible(value => value + PAGE)}>
      Show more photos ({(photos.length - visible).toLocaleString('en-US')} remaining)
    </button>}
    {viewerReady && stage && createPortal(
      <Slideshow album={albumId} photos={photos} initialId={viewing} onExit={onCloseViewer} onHome={onHome} />, stage)}
  </main>;
}
