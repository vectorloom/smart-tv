import type { Album } from './api';
import { Clock } from './Clock';
import { PhoneIcon } from './icons';
import { PhotoStage } from './PhotoStage';
import type { useRemote } from './remote';
import { WeatherForecastSlots, WeatherNow, useWeather, weatherCredit } from './Weather';

type Remote = ReturnType<typeof useRemote>;

/** Layout A: photo slideshow on the left, clock and weather in a 520px rail. Never scrolls. */
export function Home({ albums, remote, expanded, onOpenAlbum, onAllAlbums }: {
  albums: Album[]; remote: Remote; expanded: boolean; onOpenAlbum: (album: Album) => void; onAllAlbums: () => void;
}) {
  const weather = useWeather();
  return <div className="home">
    <PhotoStage albums={albums} expanded={expanded} onOpenAlbum={onOpenAlbum} onAllAlbums={onAllAlbums}>
      {remote.code && <div className="pair-card" role="status">
        <p className="label">Pair your phone</p>
        <p>On your phone, open <strong>{location.host}/remote</strong> and enter</p>
        <p className="pair-code"><span>{remote.code.slice(0, 4)}</span><span>{remote.code.slice(4)}</span></p>
        <p className="pair-expiry">The code expires in two minutes.</p>
      </div>}
    </PhotoStage>
    <aside className="rail" aria-label="Clock and weather">
      <Clock />
      <WeatherNow state={weather} />
      <WeatherForecastSlots state={weather} />
      <footer className="rail-footer">
        <span>{weatherCredit(weather)}</span>
        {remote.paired
          ? <button className="pill pill-small" onClick={() => remote.send({ type: 'unpair' })}><PhoneIcon />Unpair phone</button>
          : <button className="pill pill-small" disabled={!remote.ready} onClick={() => remote.send({ type: 'code' })}>
            <PhoneIcon />{remote.code ? 'New code' : 'Pair phone'}
          </button>}
      </footer>
    </aside>
  </div>;
}
