import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./api', async original => ({ ...await original<typeof import('./api')>(), getWeather: vi.fn() }));
import { getWeather, type WeatherForecast } from './api';
import { formatClock } from './Clock';
import { weatherKind } from './icons';
import { stageScale } from './Stage';
import { FiveDays, REFRESH_EVERY, TempChart, WeatherForecastSlots, WeatherNow, WeatherProvider, hourLabel, labelledHours, remaining,
  updatedText, useWeather, weatherCredit } from './Weather';

const hourly = Array.from({ length: 12 }, (_, i) => ({
  time: `2026-11-12T${String(13 + i).padStart(2, '0')}:00`.replace('T24', 'T00'), temperatureF: 70 - i,
  weatherCode: 0, condition: 'Clear', precipitationProbability: 0,
}));
const daily = [0, 19, 20, 55, null, 80, 90].map((rain, i) => ({
  date: `2026-11-${12 + i}`, highF: 74 + i, lowF: 51 + i, weatherCode: 61, condition: 'Rain', precipitationProbability: rain,
}));
const forecast: WeatherForecast = {
  location: 'Coppell', lastUpdated: '2026-11-12T19:14:00Z', stale: false,
  current: { time: '2026-11-12T13:00', temperatureF: 71.6, weatherCode: 0, condition: 'Clear', isDay: true, precipitationProbability: 10,
    relativeHumidity: 41.2, windSpeedMph: 12.4, windDirectionDegrees: 225, pressureHpa: 1012 },
  hourly, daily,
};

describe('home weather rail', () => {
  it('summarises current conditions with today’s high and low, without pressure', () => {
    render(<WeatherNow state={{ forecast, loading: false, failed: false }} />);
    expect(screen.getByText('72°')).toBeInTheDocument();
    expect(screen.getByText('Clear · Coppell · H 74° L 51°')).toBeInTheDocument();
    expect(screen.getByText('41%')).toBeInTheDocument();
    expect(screen.getByText('12 mph SW')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
    expect(screen.queryByText(/hPa/)).toBeNull();
  });

  it('keeps every weather slot in place with muted placeholders while loading or offline', () => {
    const { rerender } = render(<><WeatherNow state={{ forecast: null, loading: true, failed: false }} />
      <WeatherForecastSlots state={{ forecast: null, loading: true, failed: false }} /></>);
    expect(screen.getByText('Loading weather…')).toBeInTheDocument();
    rerender(<><WeatherNow state={{ forecast: null, loading: false, failed: true }} />
      <WeatherForecastSlots state={{ forecast: null, loading: false, failed: true }} /></>);
    expect(screen.getByText('Weather unavailable · retrying')).toBeInTheDocument();
    expect(screen.getByText('—°', { selector: '.wn-temp' })).toBeInTheDocument();
    expect(document.querySelectorAll('.wn-stats dd')).toHaveLength(3);
    // Chart keeps its axis (Now, +3h, +6h, +9h, last) and the five day tiles keep their names.
    expect([...document.querySelectorAll('.hours-chart.is-placeholder .chart-time')].map(t => t.textContent)[0]).toBe('Now');
    expect(document.querySelectorAll('.hours-chart.is-placeholder .chart-time')).toHaveLength(5);
    expect([...document.querySelectorAll('.days.is-placeholder .day-name')].map(d => d.textContent)[0]).toBe('Today');
    expect(document.querySelectorAll('.days.is-placeholder .day')).toHaveLength(5);
  });

  it('shows five days and a rain chance only from 20%', () => {
    render(<FiveDays days={daily} />);
    const days = screen.getAllByRole('listitem');
    expect(days).toHaveLength(5);
    expect(days.map(day => day.querySelector('.day-name')!.textContent)).toEqual(['Today', 'Fri', 'Sat', 'Sun', 'Mon']);
    expect(days.map(day => day.querySelector('.day-rain')!.textContent)).toEqual(['', '', '20%', '55%', '']);
  });

  it('labels only Now, +3h, +6h, +9h and the last hour on the chart', () => {
    expect(labelledHours(12)).toEqual([0, 3, 6, 9, 11]);
    expect(labelledHours(10)).toEqual([0, 3, 6, 9]);
    expect(hourLabel('2026-11-12T00:00')).toBe('12 AM');
    expect(hourLabel('2026-11-12T13:00')).toBe('1 PM');
    render(<TempChart hours={hourly} />);
    expect([...document.querySelectorAll('.chart-time')].map(t => t.textContent)).toEqual(['Now', '4 PM', '7 PM', '10 PM', '12 AM']);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('Now 70°'));
  });

  it('credits Open-Meteo with the update time and flags stale data', () => {
    const sameDay = new Date(forecast.lastUpdated);
    expect(weatherCredit({ forecast, loading: false, failed: false }, sameDay)).toMatch(/^Weather by Open-Meteo · updated \d{1,2}:14 [AP]M$/);
    expect(weatherCredit({ forecast, loading: false, failed: true }, sameDay)).toMatch(/^Open-Meteo · updated \d{1,2}:14 [AP]M · offline$/);
    expect(weatherCredit({ forecast: null, loading: true, failed: false })).toBe('Weather by Open-Meteo · loading…');
    expect(weatherCredit({ forecast: null, loading: false, failed: true })).toBe('Weather by Open-Meteo · unavailable, retrying');
    expect(updatedText('2026-11-11T21:04:00Z', new Date('2026-11-13T18:00:00Z'))).toMatch(/^updated Nov 1[01], \d{1,2}:04 [AP]M$/);
  });

  it('drops hours and days that have passed from a stale forecast, and shows placeholders if too little is left', () => {
    const stale = { ...forecast, stale: true };
    const later = new Date(2026, 10, 12, 20, 30);
    expect(remaining(stale, later).hours!.map(h => h.time)[0]).toBe('2026-11-12T20:00');
    expect(remaining(stale, new Date(2026, 10, 13, 1)).hours).toBeNull();
    expect(remaining(stale, new Date(2026, 10, 14, 9)).days!.map(d => d.date)[0]).toBe('2026-11-14');
    expect(remaining(stale, new Date(2026, 10, 16, 9)).days).toBeNull();
    // A live forecast is used as the server sent it.
    expect(remaining(forecast, new Date(2026, 10, 13, 1)).hours).toHaveLength(12);
  });
});

describe('weather source', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); vi.mocked(getWeather).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });
  function Probe() {
    const { forecast, failed } = useWeather();
    return <p>{forecast ? `${forecast.location}${forecast.stale ? ' (stale)' : ''}` : 'none'}{failed ? ' failed' : ''}</p>;
  }

  it('recovers within seconds when the first request fails (the API was still starting)', async () => {
    vi.mocked(getWeather).mockRejectedValueOnce(new Error('502')).mockResolvedValue(forecast);
    render(<WeatherProvider><Probe /></WeatherProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('none failed')).toBeInTheDocument();
    // Previously the next attempt only came with the seven-minute refresh.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText('Coppell')).toBeInTheDocument();
    expect(getWeather).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_EVERY - 1); });
    expect(getWeather).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getWeather).toHaveBeenCalledTimes(3);
  });

  it('shows the last forecast this browser saw, marked stale, until the API answers', async () => {
    vi.setSystemTime(new Date('2026-11-12T20:00:00Z'));
    localStorage.setItem('still.weather', JSON.stringify(forecast));
    vi.mocked(getWeather).mockRejectedValue(new Error('down'));
    render(<WeatherProvider><Probe /></WeatherProvider>);
    expect(screen.getByText('Coppell (stale)')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Coppell (stale) failed')).toBeInTheDocument();
    // Forecasts more than a day old are not shown.
    vi.setSystemTime(new Date('2026-11-14T20:00:00Z'));
    render(<WeatherProvider><p className="second"><Probe /></p></WeatherProvider>);
    expect(document.querySelector('.second')).toHaveTextContent('none');
  });
});

describe('formatting helpers', () => {
  it('formats a 12-hour clock without seconds', () => {
    expect(formatClock(new Date(2026, 10, 12, 0, 5, 59))).toEqual({ time: '12:05', period: 'AM' });
    expect(formatClock(new Date(2026, 10, 12, 13, 0))).toEqual({ time: '1:00', period: 'PM' });
  });
  it('maps WMO codes to icon kinds', () => {
    expect([0, 2, 3, 45, 61, 81, 73, 95].map(weatherKind)).toEqual(['clear', 'partly', 'cloudy', 'fog', 'rain', 'rain', 'snow', 'storm']);
  });
  it('scales the 1920×1080 stage to fit, letterboxing non-16:9 viewports', () => {
    expect(stageScale(1920, 1080)).toBe(1);
    expect(stageScale(1280, 720)).toBeCloseTo(2 / 3);
    expect(stageScale(960, 540)).toBe(.5);
    expect(stageScale(1280, 650)).toBeCloseTo(650 / 1080);
  });
});
