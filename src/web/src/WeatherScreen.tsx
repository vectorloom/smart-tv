import type { WeatherForecast } from './api';
import { WeatherIcon } from './icons';
import { TempChart, WeatherNow, remaining, useWeather, weatherCredit } from './Weather';
import { WindMap } from './WindMap';

const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });

function Week({ days }: { days: WeatherForecast['daily'] | null }) {
  if (!days) return <ol className="week is-placeholder">{Array.from({ length: 7 }, (_, i) =>
    <li key={i}><span className="week-day">—</span></li>)}</ol>;
  return <ol className="week">{days.map((day, index) => {
    const rain = day.precipitationProbability;
    return <li key={day.date}>
      <span className="week-day">{index === 0 ? 'Today' : weekday.format(new Date(`${day.date}T12:00:00Z`))}</span>
      <WeatherIcon code={day.weatherCode} className="week-icon" title={day.condition} />
      <span className="week-condition">{day.condition}</span>
      <span className="week-rain">{rain !== null && rain >= 20 ? `${rain}%` : ''}</span>
      <span className="week-temps"><strong>{Math.round(day.highF)}°</strong> {Math.round(day.lowF)}°</span>
    </li>;
  })}</ol>;
}

/** /weather — current conditions, the next 12 hours, seven days and the regional wind map. */
export function WeatherScreen() {
  const weather = useWeather();
  const { forecast } = weather;
  const ahead = forecast ? remaining(forecast) : { hours: null, days: null };
  return <main className="screen-page weather-screen">
    <header className="screen-header">
      <h1>Weather</h1>
      <p className="screen-sub">{weatherCredit(weather)}</p>
    </header>
    <div className="weather-grid">
      <div className="weather-col">
        <WeatherNow state={weather} />
        <section aria-label="7-day forecast"><h2 className="label">7 days</h2><Week days={ahead.days} /></section>
      </div>
      <div className="weather-col">
        <section className="hours" aria-label="Next 12 hours">
          <h2 className="label">Next 12 hours</h2>
          <TempChart hours={ahead.hours} />
        </section>
        <section className="wind" aria-label="Regional wind">
          <h2 className="label">Wind</h2>
          {forecast
            ? <WindMap location={forecast.location} speedMph={forecast.current.windSpeedMph} directionDegrees={forecast.current.windDirectionDegrees} />
            : <div className="wind-placeholder" />}
        </section>
      </div>
    </div>
  </main>;
}
