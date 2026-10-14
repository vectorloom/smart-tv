import { useEffect, useState } from 'react';
import { getWeather, type WeatherForecast } from './api';

const refreshEvery = 7 * 60 * 1000;

function icon(code: number, day = true): string {
  if (code === 0) return day ? '☀' : '☾';
  if (code === 1 || code === 2) return day ? '🌤' : '☁';
  if (code === 3 || code === 45 || code === 48) return '☁';
  if (code >= 51 && code <= 67 || code >= 80 && code <= 82) return '🌧';
  if (code >= 71 && code <= 77 || code >= 85 && code <= 86) return '❄';
  if (code >= 95) return '⛈';
  return '☁';
}

function hourLabel(value: string, current: boolean): string {
  if (current) return 'Now';
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute] = match;
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))));
}

export function WeatherPanel() {
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const next = await getWeather(controller.signal);
        if (active) { setForecast(next); setFailed(false); }
      } catch {
        if (active && !controller.signal.aborted) {
          setFailed(true);
          setForecast(previous => previous ? { ...previous, stale: true } : null);
        }
      } finally { if (active) setLoading(false); }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, refreshEvery);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, []);

  if (!forecast) return <section className="weather-panel weather-unavailable" aria-label="Weather forecast" aria-live="polite">
    <span className="weather-icon" aria-hidden="true">☁</span>
    <div><h2>{loading ? 'Loading DFW weather…' : 'Weather unavailable'}</h2>
      {!loading && <p>{failed ? 'The forecast could not be reached. It will retry automatically.' : 'Waiting for the forecast.'}</p>}</div>
  </section>;

  const isStale = forecast.stale || failed;
  const updated = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(forecast.lastUpdated));
  return <section className="weather-panel" aria-label="Weather forecast" aria-live="polite">
    <div className="weather-heading">
      <div className="weather-current">
        <span className="weather-icon weather-current-icon" aria-hidden="true">{icon(forecast.current.weatherCode, forecast.current.isDay)}</span>
        <div><p className="weather-location">{forecast.location}</p>
          <a className="weather-source" href="https://open-meteo.com/" tabIndex={-1}>Weather data by Open-Meteo</a>
          <div className="weather-temperature">{Math.round(forecast.current.temperatureF)}°</div>
          <p className="weather-condition">{forecast.current.condition}
            {forecast.current.precipitationProbability !== null && <> <span>· {forecast.current.precipitationProbability}% rain</span></>}</p>
        </div>
      </div>
      <p className={`weather-updated${isStale ? ' is-stale' : ''}`}>{isStale ? 'STALE · ' : ''}UPDATED {updated}</p>
    </div>
    <div className="weather-forecasts">
      <div className="weather-forecast-group">
        <div className="weather-group-title">NEXT 12 HOURS</div>
        <div className="weather-hourly">{forecast.hourly.map((hour, index) => <div className="weather-hour" key={hour.time}>
          <span>{hourLabel(hour.time, index === 0)}</span><span className="weather-small-icon" aria-hidden="true">{icon(hour.weatherCode)}</span>
          <strong>{Math.round(hour.temperatureF)}°</strong><small>{hour.precipitationProbability === null ? '—' : `${hour.precipitationProbability}%`}</small>
        </div>)}</div>
      </div>
      <div className="weather-forecast-group">
        <div className="weather-group-title">7-DAY FORECAST</div>
        <div className="weather-daily">{forecast.daily.map((day, index) => <div className="weather-day" key={day.date}>
          <span>{index === 0 ? 'Today' : new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`))}</span>
          <span className="weather-small-icon" aria-hidden="true">{icon(day.weatherCode)}</span>
          <strong>{Math.round(day.highF)}° <span>{Math.round(day.lowF)}°</span></strong>
          <small>{day.precipitationProbability === null ? '—' : `${day.precipitationProbability}%`}</small>
        </div>)}</div>
      </div>
    </div>
  </section>;
}
