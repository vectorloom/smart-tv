export type Album = { id: string; name: string; assetCount: number; thumbnailId?: string | null };
export type Photo = { id: string; name: string };
export type PhotoPage = { items: Photo[]; nextPage: number | null };
export type WeatherPeriod = { time: string; temperatureF: number; weatherCode: number; condition: string; precipitationProbability: number | null };
export type WeatherForecast = {
  location: string; lastUpdated: string; stale: boolean;
  current: WeatherPeriod & { isDay: boolean; relativeHumidity: number; windSpeedMph: number; windDirectionDegrees: number; pressureHpa: number };
  hourly: WeatherPeriod[];
  daily: Array<{ date: string; highF: number; lowF: number; weatherCode: number; condition: string; precipitationProbability: number | null }>;
};
export type RegionalWind = {
  location: string; lastUpdated: string; stale: boolean; validTime: string;
  points: Array<{ latitude: number; longitude: number; windSpeedMph: number; windDirectionDegrees: number }>;
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
  const current = object(data) && object(data.current) ? data.current : null;
  if (!object(data) || typeof data.location !== 'string' || typeof data.lastUpdated !== 'string' || typeof data.stale !== 'boolean' ||
      !object(data.current) || !period(data.current) || typeof (data.current as Record<string, unknown>).isDay !== 'boolean' ||
      !current || typeof current.relativeHumidity !== 'number' || !Number.isFinite(current.relativeHumidity) ||
      typeof current.windSpeedMph !== 'number' || !Number.isFinite(current.windSpeedMph) ||
      typeof current.windDirectionDegrees !== 'number' || !Number.isFinite(current.windDirectionDegrees) ||
      typeof current.pressureHpa !== 'number' || !Number.isFinite(current.pressureHpa) ||
      !Array.isArray(data.hourly) || data.hourly.length === 0 || !data.hourly.every(period) ||
      !Array.isArray(data.daily) || data.daily.length !== 7 || !data.daily.every(day => object(day) &&
        typeof day.date === 'string' && typeof day.highF === 'number' && typeof day.lowF === 'number' &&
        typeof day.weatherCode === 'number' && typeof day.condition === 'string' &&
        (day.precipitationProbability === null || typeof day.precipitationProbability === 'number')))
    throw new Error('Weather forecast is incomplete. It will retry automatically.');
  return data as unknown as WeatherForecast;
}

export async function getRegionalWind(signal?: AbortSignal): Promise<RegionalWind> {
  const response = await fetch('/api/weather/wind', { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message ?? 'Regional wind data is temporarily unavailable.');
  }
  const data: unknown = await response.json();
  const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
  const validTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (!object(data) || typeof data.location !== 'string' || !validTime(data.lastUpdated) || !validTime(data.validTime) ||
      typeof data.stale !== 'boolean' || !Array.isArray(data.points) || data.points.length !== 25 ||
      !data.points.every(point => object(point) && typeof point.latitude === 'number' && Number.isFinite(point.latitude) &&
        point.latitude >= -90 && point.latitude <= 90 && typeof point.longitude === 'number' && Number.isFinite(point.longitude) &&
        point.longitude >= -180 && point.longitude <= 180 && typeof point.windSpeedMph === 'number' &&
        Number.isFinite(point.windSpeedMph) && point.windSpeedMph >= 0 && typeof point.windDirectionDegrees === 'number' &&
        Number.isFinite(point.windDirectionDegrees) && point.windDirectionDegrees >= 0 && point.windDirectionDegrees < 360))
    throw new Error('Regional wind grid is incomplete. It will retry automatically.');
  const points = data.points as Array<{ latitude: number; longitude: number }>;
  if (new Set(points.map(point => `${point.latitude},${point.longitude}`)).size !== 25 ||
      new Set(points.map(point => point.latitude)).size !== 5 || new Set(points.map(point => point.longitude)).size !== 5)
    throw new Error('Regional wind grid is malformed. It will retry automatically.');
  return data as unknown as RegionalWind;
}
