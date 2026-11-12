import type { Album } from './api';
import { Clock } from './Clock';
import { PhotoStage } from './PhotoStage';
import { WeatherForecastSlots, WeatherNow, useWeather, weatherCredit } from './Weather';

/** Layout A: photo slideshow on the left, clock and weather in a 520px rail. Never scrolls. */
export function Home({ albums, expanded, onOpenAlbum, onAllAlbums }: {
  albums: Album[]; expanded: boolean; onOpenAlbum: (album: Album) => void; onAllAlbums: () => void;
}) {
  const weather = useWeather();
  return <div className="home">
    <PhotoStage albums={albums} expanded={expanded} onOpenAlbum={onOpenAlbum} onAllAlbums={onAllAlbums} />
    <aside className="rail" aria-label="Clock and weather">
      <Clock />
      <WeatherNow state={weather} />
      <WeatherForecastSlots state={weather} />
      <footer className="rail-footer"><span>{weatherCredit(weather)}</span></footer>
    </aside>
  </div>;
}
