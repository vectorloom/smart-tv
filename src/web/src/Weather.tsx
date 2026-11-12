import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { getWeather, parseForecast, type WeatherForecast, type WeatherPeriod } from './api';
import { DropletIcon, UmbrellaIcon, WeatherIcon, WindIcon } from './icons';

/** Refresh a good forecast every seven minutes (the server caches Open-Meteo for twenty). */
export const REFRESH_EVERY = 7 * 60 * 1000;
/** After a failure, retry quickly at first: a restarting API or a blip should not blank the rail for minutes. */
export const RETRY_DELAYS = [5_000, 10_000, 20_000, 30_000, 60_000];
const STORAGE_KEY = 'still.weather';
const STORED_MAX_AGE = 24 * 60 * 60 * 1000;

export type WeatherState = { forecast: WeatherForecast | null; loading: boolean; failed: boolean };

function readStored(): WeatherForecast | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const forecast = raw ? parseForecast(JSON.parse(raw)) : null;
    if (!forecast || Date.now() - Date.parse(forecast.lastUpdated) > STORED_MAX_AGE) return null;
    return { ...forecast, stale: true };
  } catch { return null; }
}
function store(forecast: WeatherForecast) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(forecast)); } catch { /* storage unavailable: memory only */ }
}

/**
 * Same-origin forecast shared by every screen. Shows the last forecast this browser saw (marked
 * stale) until the first answer, keeps the last good forecast on failure, and retries failures with
 * a short backoff instead of waiting for the next seven-minute refresh.
 */
function useWeatherSource(): WeatherState {
  const [state, setState] = useState<WeatherState>(() => ({ forecast: readStored(), loading: true, failed: false }));
  useEffect(() => {
    let active = true;
    let timer = 0;
    let failures = 0;
    let controller = new AbortController();
    const schedule = (delay: number) => { window.clearTimeout(timer); timer = window.setTimeout(() => { void refresh(); }, delay); };
    const refresh = async () => {
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      try {
        const forecast = await getWeather(signal);
        if (!active || signal.aborted) return;
        failures = 0;
        store(forecast);
        setState({ forecast, loading: false, failed: false });
        schedule(REFRESH_EVERY);
      } catch {
        if (!active || signal.aborted) return;
        setState(previous => ({ forecast: previous.forecast, loading: false, failed: true }));
        schedule(RETRY_DELAYS[Math.min(failures++, RETRY_DELAYS.length - 1)]);
      }
    };
    // Coming back online or to a visible tab: retry now if the last attempt failed.
    const retryNow = () => { if (failures > 0 && document.visibilityState !== 'hidden') void refresh(); };
    void refresh();
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', retryNow);
    return () => {
      active = false; controller.abort(); window.clearTimeout(timer);
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', retryNow);
    };
  }, []);
  return state;
}

const WeatherContext = createContext<WeatherState | null>(null);

/** Mount once above the screens so navigating between them never resets the forecast. */
export function WeatherProvider({ children }: { children: ReactNode }) {
  return <WeatherContext.Provider value={useWeatherSource()}>{children}</WeatherContext.Provider>;
}

export function useWeather(): WeatherState {
  const state = useContext(WeatherContext);
  if (!state) throw new Error('useWeather must be used inside <WeatherProvider>.');
  return state;
}

const degrees = (value: number) => `${Math.round(value)}°`;
const compass = (value: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(value / 45) % 8];

/** "9 PM" from Open-Meteo's local "2026-11-12T21:00" without any timezone conversion. */
export function hourLabel(time: string): string {
  const hour = Number(/T(\d{2})/.exec(time)?.[1] ?? NaN);
  return Number.isNaN(hour) ? time : `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

function statusText({ loading, failed }: WeatherState) {
  return loading && !failed ? 'Loading weather…' : 'Weather unavailable · retrying';
}

export function WeatherNow({ state }: { state: WeatherState }) {
  const { forecast } = state;
  if (!forecast) return <section className="weather-now is-placeholder" aria-label="Current weather" aria-live="polite">
    <div className="wn-main">
      <WeatherIcon code={3} className="wn-icon" />
      <div className="wn-temp">—°</div>
    </div>
    <p className="wn-summary">{statusText(state)}</p>
    <dl className="wn-stats">
      <div><dt><DropletIcon />Humidity</dt><dd>—</dd></div>
      <div><dt><WindIcon />Wind</dt><dd>—</dd></div>
      <div><dt><UmbrellaIcon />Rain</dt><dd>—</dd></div>
    </dl>
  </section>;
  const { current } = forecast;
  const today = forecast.daily[0];
  const rain = current.precipitationProbability;
  return <section className="weather-now" aria-label="Current weather">
    <div className="wn-main">
      <WeatherIcon code={current.weatherCode} isDay={current.isDay} className="wn-icon" />
      <div className="wn-temp">{degrees(current.temperatureF)}</div>
    </div>
    <p className="wn-summary">{current.condition} · {forecast.location}{today && <> · H {degrees(today.highF)} L {degrees(today.lowF)}</>}</p>
    <dl className="wn-stats">
      <div><dt><DropletIcon />Humidity</dt><dd>{Math.round(current.relativeHumidity)}%</dd></div>
      <div><dt><WindIcon />Wind</dt><dd>{Math.round(current.windSpeedMph)} mph {compass(current.windDirectionDegrees)}</dd></div>
      <div><dt><UmbrellaIcon />Rain</dt><dd>{rain === null ? '—' : `${rain}%`}</dd></div>
    </dl>
  </section>;
}

const chartPad = { x: 10, top: 40, bottom: 30 };

/** Hours to label on the chart: Now, +3h, +6h, +9h and the last hour. */
export function labelledHours(count: number): number[] {
  return [...new Set([0, 3, 6, 9, count - 1].filter(i => i >= 0 && i < count))];
}

/** Local "YYYY-MM-DDTHH:00" for the next hours, so placeholders can label the axis before data arrives. */
export function upcomingHours(now: Date, count = 12): string[] {
  return Array.from({ length: count }, (_, i) => {
    const hour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + i);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${hour.getFullYear()}-${pad(hour.getMonth() + 1)}-${pad(hour.getDate())}T${pad(hour.getHours())}:00`;
  });
}

/** Measures the box in layout px (unaffected by the stage transform), then follows resizes. */
function useBoxSize(fallback: { width: number; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = (width: number, height: number) => {
      if (width > 0 && height > 0) setSize(old => old.width === Math.round(width) && old.height === Math.round(height)
        ? old : { width: Math.round(width), height: Math.round(height) });
    };
    measure(element.clientWidth, element.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width, entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [box, size] as const;
}

/**
 * Temperature line for the next hours. The viewBox tracks the rendered size so strokes and text are
 * never stretched; without data the same box shows a muted flat line and the hour labels.
 */
export function TempChart({ hours, status }: { hours: WeatherPeriod[] | null; status?: string }) {
  const [box, { width, height }] = useBoxSize({ width: 520, height: 170 });
  const gradient = useId();
  const placeholder = !hours || hours.length < 2;
  const times = placeholder ? upcomingHours(new Date()) : hours.map(hour => hour.time);
  const count = times.length;
  const x = (i: number) => chartPad.x + i * (width - 2 * chartPad.x) / (count - 1);
  const baseline = height - chartPad.bottom;
  const marks = labelledHours(count);
  const anchor = (i: number) => i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle';
  const label = (i: number) => i === 0 ? 'Now' : hourLabel(times[i]);
  const svg = { viewBox: `0 0 ${width} ${height}`, width: '100%', height: '100%' };

  if (placeholder) {
    const mid = (chartPad.top + baseline) / 2;
    return <div className="hours-chart is-placeholder" ref={box}>
      <svg {...svg} role="img" aria-label={status ?? 'Temperature chart unavailable'}>
        <path d={`M${x(0)} ${mid}H${x(count - 1)}`} className="chart-line" />
        {marks.map(i => <g key={i} className="chart-mark">
          <circle cx={x(i)} cy={mid} r="5.5" />
          <text className="chart-time" x={x(i)} y={height - 6} textAnchor={anchor(i)}>{label(i)}</text>
        </g>)}
      </svg>
    </div>;
  }

  const temps = hours.map(hour => hour.temperatureF);
  const min = Math.min(...temps), max = Math.max(...temps);
  const span = Math.max(max - min, 4);
  const mid = (min + max) / 2;
  const y = (t: number) => chartPad.top + (0.5 - (t - mid) / span) * (height - chartPad.top - chartPad.bottom - 8);
  const line = temps.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(t).toFixed(1)}`).join('');
  return <div className="hours-chart" ref={box}>
    <svg {...svg} role="img"
      aria-label={`Temperature, next ${count} hours: ${marks.map(i => `${label(i)} ${degrees(temps[i])}`).join(', ')}`}>
      <defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stopColor="var(--accent)" stopOpacity=".28" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
      </linearGradient></defs>
      <path d={`${line}L${x(count - 1).toFixed(1)} ${baseline}L${x(0).toFixed(1)} ${baseline}Z`} fill={`url(#${gradient})`} />
      <path d={line} className="chart-line" />
      {marks.map(i => <g key={i} className="chart-mark">
        <circle cx={x(i)} cy={y(temps[i])} r="5.5" />
        <text className="chart-temp" x={x(i)} y={y(temps[i]) - 14} textAnchor={anchor(i)}>{degrees(temps[i])}</text>
        <text className="chart-time" x={x(i)} y={height - 6} textAnchor={anchor(i)}>{label(i)}</text>
      </g>)}
    </svg>
  </div>;
}

const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const localWeekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' });

/** Five day tiles; without data the tiles stay in place with day names and muted dashes. */
export function FiveDays({ days }: { days: WeatherForecast['daily'] | null }) {
  if (!days) {
    const today = new Date();
    return <ol className="days is-placeholder">{Array.from({ length: 5 }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + index);
      return <li className="day" key={index}>
        <span className="day-name">{index === 0 ? 'Today' : localWeekday.format(date)}</span>
        <span className="day-icon day-icon-empty" aria-hidden="true" />
        <span className="day-temps"><strong>—</strong></span>
        <span className="day-rain" />
      </li>;
    })}</ol>;
  }
  return <ol className="days">{days.slice(0, 5).map((day, index) => {
    const rain = day.precipitationProbability;
    return <li className="day" key={day.date}>
      <span className="day-name">{index === 0 ? 'Today' : weekday.format(new Date(`${day.date}T12:00:00Z`))}</span>
      <WeatherIcon code={day.weatherCode} className="day-icon" title={day.condition} />
      <span className="day-temps"><strong>{degrees(day.highF)}</strong> {degrees(day.lowF)}</span>
      <span className="day-rain">{rain !== null && rain >= 20 ? `${rain}%` : ''}</span>
    </li>;
  })}</ol>;
}

const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** "updated 1:02 PM", or "updated Nov 11, 3:04 PM" when the forecast is from another day. */
export function updatedText(lastUpdated: string, now = new Date()): string {
  const updated = new Date(lastUpdated);
  const sameDay = updated.toDateString() === now.toDateString();
  return `updated ${sameDay ? '' : `${dayFormat.format(updated)}, `}${timeFormat.format(updated)}`;
}

export function weatherCredit(state: WeatherState, now = new Date()): string {
  const { forecast, failed, loading } = state;
  if (!forecast) return `Weather by Open-Meteo · ${loading && !failed ? 'loading…' : 'unavailable, retrying'}`;
  // Offline, the shorter source name leaves room for the time the shown forecast is from.
  return forecast.stale || failed
    ? `Open-Meteo · ${updatedText(forecast.lastUpdated, now)} · offline`
    : `Weather by Open-Meteo · ${updatedText(forecast.lastUpdated, now)}`;
}

/**
 * Hours and days still ahead. A live forecast starts at the server's "now"; a stale one (served from
 * a cache while Open-Meteo or the API is down) drops hours and days that have already passed.
 */
export function remaining(forecast: WeatherForecast, now = new Date()) {
  if (!forecast.stale) return { hours: forecast.hourly.slice(0, 12), days: forecast.daily };
  const hour = upcomingHours(now, 1)[0];
  const hours = forecast.hourly.filter(h => h.time >= hour).slice(0, 12);
  const days = forecast.daily.filter(d => d.date >= hour.slice(0, 10));
  return { hours: hours.length >= 2 ? hours : null, days: days.length >= 5 ? days : null };
}

/** The rail's chart and five-day slots, always present so the layout never shifts or blanks. */
export function WeatherForecastSlots({ state }: { state: WeatherState }) {
  const { forecast } = state;
  const ahead = forecast ? remaining(forecast) : { hours: null, days: null };
  return <>
    <section className="hours" aria-label="Next 12 hours">
      <h2 className="label">Next 12 hours</h2>
      <TempChart hours={ahead.hours} status={ahead.hours ? undefined : statusText(state)} />
    </section>
    <section aria-label="5-day forecast">
      <h2 className="label">5 days</h2>
      <FiveDays days={ahead.days} />
    </section>
  </>;
}
