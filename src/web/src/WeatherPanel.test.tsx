import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WeatherPanel } from './WeatherPanel';
import { getWeather } from './api';

vi.mock('./api', () => ({ getWeather: vi.fn() }));

const forecast = {
  location: 'Dallas–Fort Worth', lastUpdated: '2026-09-26T14:00:00Z', stale: false,
  current: { time: '2026-09-26T09:00', temperatureF: 81.4, weatherCode: 2, condition: 'Partly cloudy', isDay: true, precipitationProbability: 10 },
  hourly: Array.from({ length: 12 }, (_, i) => ({ time: `2026-09-26T${String(9 + i).padStart(2, '0')}:00`, temperatureF: 82 + i, weatherCode: i % 2 ? 3 : 0, condition: 'Clear sky', precipitationProbability: i * 5 })),
  daily: Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 26 + i)).toISOString().slice(0, 10), highF: 87 - i, lowF: 70 - i, weatherCode: i === 2 ? 61 : 2, condition: i === 2 ? 'Light rain' : 'Partly cloudy', precipitationProbability: 10 + i * 5 })),
};

describe('WeatherPanel', () => {
  beforeEach(() => vi.mocked(getWeather).mockReset());

  it('shows a loading message before the forecast resolves', async () => {
    let finish!: (value: typeof forecast) => void;
    vi.mocked(getWeather).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<WeatherPanel />);
    expect(screen.getByText('Loading DFW weather…')).toBeInTheDocument();
    await act(async () => finish(forecast));
    expect(await screen.findByText('Dallas–Fort Worth')).toBeInTheDocument();
  });

  it('displays current conditions, hourly details, and all seven days', async () => {
    vi.mocked(getWeather).mockResolvedValue(forecast);
    render(<WeatherPanel />);
    expect(await screen.findByText('Dallas–Fort Worth')).toBeInTheDocument();
    expect(screen.getAllByText('81°').length).toBeGreaterThan(0);
    expect(screen.getByText(/Partly cloudy/)).toBeInTheDocument();
    expect(screen.getByText('NEXT 12 HOURS')).toBeInTheDocument();
    expect(screen.getByText('7-DAY FORECAST')).toBeInTheDocument();
    expect(screen.getAllByText(/%$/)).toHaveLength(19);
    expect(screen.getByText(/UPDATED/)).toBeInTheDocument();
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

  it('refreshes automatically every seven minutes', async () => {
    vi.useFakeTimers();
    vi.mocked(getWeather).mockResolvedValue(forecast);
    render(<WeatherPanel />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getWeather).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(7 * 60 * 1000); });
    expect(getWeather).toHaveBeenCalledTimes(2);
  });
});
