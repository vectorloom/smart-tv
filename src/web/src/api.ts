export type Album = { id: string; name: string; assetCount: number; thumbnailId?: string | null };
export type Photo = { id: string; name: string };
export type PhotoPage = { items: Photo[]; nextPage: number | null };
export type WeatherPeriod = { time: string; temperatureF: number; weatherCode: number; condition: string; precipitationProbability: number | null };
export type WeatherForecast = {
  location: string; lastUpdated: string; stale: boolean;
  current: WeatherPeriod & { isDay: boolean };
  hourly: WeatherPeriod[];
  daily: Array<{ date: string; highF: number; lowF: number; weatherCode: number; condition: string; precipitationProbability: number | null }>;
};

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message ?? 'Could not load your photos. Please try again.');
  }
  return response.json() as Promise<T>;
}

export const imageUrl = (album: string, photo: string, size: 'thumbnail' | 'preview' = 'thumbnail') =>
  `/api/albums/${encodeURIComponent(album)}/photos/${encodeURIComponent(photo)}/image?size=${size}`;

export async function getWeather(signal?: AbortSignal): Promise<WeatherForecast> {
  const response = await fetch('/api/weather', { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message ?? 'Weather is temporarily unavailable.');
  }
  const data: unknown = await response.json();
  const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
  const period = (value: unknown): value is WeatherPeriod => object(value) &&
    typeof value.time === 'string' && typeof value.temperatureF === 'number' &&
    typeof value.weatherCode === 'number' && typeof value.condition === 'string' &&
    (value.precipitationProbability === null || typeof value.precipitationProbability === 'number');
  if (!object(data) || typeof data.location !== 'string' || typeof data.lastUpdated !== 'string' || typeof data.stale !== 'boolean' ||
      !object(data.current) || !period(data.current) || typeof (data.current as Record<string, unknown>).isDay !== 'boolean' ||
      !Array.isArray(data.hourly) || data.hourly.length === 0 || !data.hourly.every(period) ||
      !Array.isArray(data.daily) || data.daily.length !== 7 || !data.daily.every(day => object(day) &&
        typeof day.date === 'string' && typeof day.highF === 'number' && typeof day.lowF === 'number' &&
        typeof day.weatherCode === 'number' && typeof day.condition === 'string' &&
        (day.precipitationProbability === null || typeof day.precipitationProbability === 'number')))
    throw new Error('Weather forecast is incomplete. It will retry automatically.');
  return data as unknown as WeatherForecast;
}
