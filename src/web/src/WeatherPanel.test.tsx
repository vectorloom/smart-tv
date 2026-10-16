import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WeatherPanel } from './WeatherPanel';
import { getRegionalWind, getWeather } from './api';

vi.mock('./api', () => ({ getRegionalWind: vi.fn(), getWeather: vi.fn() }));

const forecast = {
  location: 'Coppell', lastUpdated: '2026-09-26T14:00:00Z', stale: false,
  current: { time: '2026-09-26T09:00', temperatureF: 81.4, weatherCode: 2, condition: 'Partly cloudy', isDay: true, precipitationProbability: 10, relativeHumidity: 58, windSpeedMph: 9.2, windDirectionDegrees: 235, pressureHpa: 1008.4 },
  hourly: Array.from({ length: 12 }, (_, i) => ({ time: `2026-09-26T${String(9 + i).padStart(2, '0')}:00`, temperatureF: 82 + i, weatherCode: i % 2 ? 3 : 0, condition: 'Clear sky', precipitationProbability: i * 5 })),
  daily: Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 26 + i)).toISOString().slice(0, 10), highF: 87 - i, lowF: 70 - i, weatherCode: i === 2 ? 61 : 2, condition: i === 2 ? 'Light rain' : 'Partly cloudy', precipitationProbability: 10 + i * 5 })),
};
const regionalWind = {
  location: 'Coppell', lastUpdated: '2026-09-26T14:00:00Z', stale: false, validTime: '2026-09-26T09:00',
  points: Array.from({ length: 25 }, (_, i) => ({ latitude: 32.65 + Math.floor(i / 5) * .15, longitude: -97.17 + (i % 5) * .15, windSpeedMph: 5 + i, windDirectionDegrees: 235 })),
};

describe('WeatherPanel', () => {
  beforeEach(() => {
    vi.mocked(getWeather).mockReset();
    vi.mocked(getRegionalWind).mockReset().mockResolvedValue(regionalWind);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
  });

  it('shows a loading message before the forecast resolves', async () => {
    let finish!: (value: typeof forecast) => void;
    vi.mocked(getWeather).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<WeatherPanel />);
    expect(screen.getByText('Loading weather…')).toBeInTheDocument();
    await act(async () => finish(forecast));
    expect(await screen.findByText('Coppell')).toBeInTheDocument();
  });

  it('displays current conditions, hourly details, and all seven days', async () => {
    vi.mocked(getWeather).mockResolvedValue(forecast);
    render(<WeatherPanel />);
    expect(await screen.findByText('Coppell')).toBeInTheDocument();
    expect(screen.getAllByText('81°').length).toBeGreaterThan(0);
    expect(screen.getByText(/Partly cloudy/)).toBeInTheDocument();
    expect(screen.getByText('58%')).toBeInTheDocument();
    expect(screen.getByText('9 mph SW')).toBeInTheDocument();
    expect(screen.getByText('1008 hPa')).toBeInTheDocument();
    expect(screen.getByText('RAIN CHANCE')).toBeInTheDocument();
    expect(document.querySelector('.weather-metrics .weather-metric strong')).toHaveTextContent('10%');
    expect(screen.getByText('HUMIDITY')).toBeInTheDocument();
    expect(screen.getByText('WIND')).toBeInTheDocument();
    expect(screen.getByText('PRESSURE')).toBeInTheDocument();
    expect(document.querySelectorAll('.weather-metric-unavailable')).toHaveLength(0);
    expect(screen.getByText('NEXT 12 HOURS')).toBeInTheDocument();
    expect(screen.getByText('7-DAY FORECAST')).toBeInTheDocument();
    expect(screen.getByText('Wind map')).toBeInTheDocument();
    expect(await screen.findByText('GRID 2026-09-26T09:00')).toBeInTheDocument();
    expect(document.querySelector('.weather-wind-map')).toHaveTextContent(/Coppell.*9 mph from SW.*FLOW NE/);
    expect(document.querySelector('.weather-wind-map')).toHaveAttribute('data-grid-points', '25');
    expect(screen.getAllByText(/%$/)).toHaveLength(21);
    expect(screen.getByText(/UPDATED/)).toBeInTheDocument();
    expect(document.querySelectorAll('.weather-hour, .weather-day')).toHaveLength(19);
    expect([...document.querySelectorAll<HTMLElement>('.weather-hour, .weather-day')].every(entry => entry.tabIndex === -1)).toBe(true);
  });

  it('marks a cached forecast stale and shows a recoverable error without data', async () => {
    vi.mocked(getWeather).mockResolvedValueOnce({ ...forecast, stale: true });
    const { unmount } = render(<WeatherPanel />);
    expect(await screen.findByText(/9:00 AM/)).toBeInTheDocument();
    expect(document.querySelector('.weather-updated')).toHaveTextContent('STALE');
    unmount();

    vi.mocked(getWeather).mockRejectedValueOnce(new Error('offline'));
    render(<WeatherPanel />);
    expect(await screen.findByText('Weather unavailable')).toBeInTheDocument();
    expect(screen.getByText(/retry automatically/)).toBeInTheDocument();
  });

  it('shows loading, unavailable, and stale states for the regional wind map', async () => {
    let finish!: (value: typeof regionalWind) => void;
    vi.mocked(getWeather).mockResolvedValue(forecast);
    vi.mocked(getRegionalWind).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { unmount } = render(<WeatherPanel />);
    await screen.findByText('Coppell');
    expect(screen.getByText('LOADING WIND GRID…')).toBeInTheDocument();
    await act(async () => finish({ ...regionalWind, stale: true }));
    expect(await screen.findByText('STALE', { selector: '.weather-map-status' })).toBeInTheDocument();
    unmount();

    vi.mocked(getWeather).mockResolvedValue(forecast);
    vi.mocked(getRegionalWind).mockRejectedValue(new Error('offline'));
    render(<WeatherPanel />);
    await screen.findByText('Coppell');
    expect(await screen.findByText('WIND MAP UNAVAILABLE · RETRYING')).toBeInTheDocument();
  });

  it('refreshes automatically every seven minutes', async () => {
    vi.useFakeTimers();
    vi.mocked(getWeather).mockResolvedValue(forecast);
    render(<WeatherPanel />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getWeather).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(7 * 60 * 1000); });
    expect(getWeather).toHaveBeenCalledTimes(2);
  });

  it('retains the last successful forecast and marks it stale after a refresh failure', async () => {
    vi.useFakeTimers();
    vi.mocked(getWeather).mockResolvedValueOnce(forecast).mockRejectedValueOnce(new Error('offline'));
    render(<WeatherPanel />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Coppell')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(7 * 60 * 1000); });
    expect(screen.getByText('Coppell')).toBeInTheDocument();
    expect(document.querySelector('.weather-updated')).toHaveTextContent('STALE');
  });
});
