// Inline stroke icons on a 24×24 grid. Strokes use currentColor unless a part has a
// semantic colour (sun = amber, rain/snow = blue, cloud = cloud grey) via CSS classes.
import type { ReactNode } from 'react';

type IconProps = { className?: string; title?: string };

function Svg({ className, title, children }: IconProps & { children: ReactNode }) {
  return <svg className={`icon ${className ?? ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
    {children}
  </svg>;
}

const cloud = (dy = 0) => `M7.5 ${19 + dy}h9.25a4.25 4.25 0 0 0 .7-8.44A6 6 0 0 0 6 ${11.2 + dy}a3.9 3.9 0 0 0 1.5 ${7.8}z`;
const rays = (cx: number, cy: number, r1: number, r2: number, angles: number[]) => angles.map(a => {
  const rad = a * Math.PI / 180;
  return `M${(cx + r1 * Math.cos(rad)).toFixed(2)} ${(cy + r1 * Math.sin(rad)).toFixed(2)}L${(cx + r2 * Math.cos(rad)).toFixed(2)} ${(cy + r2 * Math.sin(rad)).toFixed(2)}`;
}).join('');

const Sun = () => <g className="i-sun"><circle cx="12" cy="12" r="4.2" /><path d={rays(12, 12, 6.8, 9.2, [0, 45, 90, 135, 180, 225, 270, 315])} /></g>;
const Moon = () => <path className="i-moon" d="M19.5 14.6A7.8 7.8 0 1 1 9.4 4.5a6.2 6.2 0 0 0 10.1 10.1z" />;
const SmallSun = () => <g className="i-sun"><circle cx="8.5" cy="8.5" r="3" /><path d={rays(8.5, 8.5, 5, 6.8, [180, 225, 270, 315])} /></g>;
const SmallMoon = () => <path className="i-moon" d="M13.2 8.6A5 5 0 1 1 6.6 2.6a3.9 3.9 0 0 0 6.6 6z" />;
const Cloud = ({ dy = 0, partial = false }: { dy?: number; partial?: boolean }) =>
  <path className="i-cloud" d={partial ? 'M10.2 20h7.3a3.6 3.6 0 0 0 .6-7.15 5 5 0 0 0-9.5.9A3.2 3.2 0 0 0 10.2 20z' : cloud(dy)} />;

export type WeatherKind = 'clear' | 'partly' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';

/** WMO weather interpretation codes, as returned by Open-Meteo. */
export function weatherKind(code: number): WeatherKind {
  if (code === 0) return 'clear';
  if (code === 1 || code === 2) return 'partly';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloudy';
}

export function WeatherIcon({ code, isDay = true, className, title }: IconProps & { code: number; isDay?: boolean }) {
  const kind = weatherKind(code);
  return <Svg className={`weather-icon is-${kind} ${className ?? ''}`} title={title}>
    {kind === 'clear' && (isDay ? <Sun /> : <Moon />)}
    {kind === 'partly' && <>{isDay ? <SmallSun /> : <SmallMoon />}<Cloud partial /></>}
    {kind === 'cloudy' && <Cloud dy={-1} />}
    {kind === 'fog' && <><Cloud dy={-4} /><path className="i-cloud" d="M4 18.5h16M6 21.5h12" /></>}
    {kind === 'rain' && <><Cloud dy={-4} /><path className="i-rain" d="M8.5 18l-1.2 3M12.5 18l-1.2 3M16.5 18l-1.2 3" /></>}
    {kind === 'snow' && <><Cloud dy={-4} /><path className="i-rain" d="M8 19.5h.01M12 18.5h.01M16 19.5h.01M10 22h.01M14 22h.01" strokeWidth="2.4" /></>}
    {kind === 'storm' && <><Cloud dy={-4} /><path className="i-sun" d="M12.8 15.5l-2.3 3.6h3l-2.3 3.6" /></>}
  </Svg>;
}

export const DropletIcon = (p: IconProps) => <Svg {...p}><path d="M12 3.5s6 6.3 6 10.6a6 6 0 0 1-12 0C6 9.8 12 3.5 12 3.5z" /></Svg>;
export const WindIcon = (p: IconProps) => <Svg {...p}><path d="M3 9h11.5a3 3 0 1 0-3-3M3 13h15.5a3 3 0 1 1-3 3M3 17h7" /></Svg>;
export const UmbrellaIcon = (p: IconProps) => <Svg {...p}><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5h-17A8.5 8.5 0 0 1 12 3.5zM12 12v6.5a2 2 0 0 0 4 0" /></Svg>;
export const GridIcon = (p: IconProps) => <Svg {...p}><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" /></Svg>;
export const PhoneIcon = (p: IconProps) => <Svg {...p}><rect x="7" y="2.5" width="10" height="19" rx="2.4" /><path d="M11 18.5h2" /></Svg>;

// Navigation rail
export const HomeIcon = (p: IconProps) => <Svg {...p}><path d="M3.5 10.8 12 4l8.5 6.8M6 9v10.5h4.5v-5.5h3v5.5H18V9" /></Svg>;
export const PhotosIcon = (p: IconProps) => <Svg {...p}><rect x="3.5" y="5" width="17" height="14" rx="2.4" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.6 3.6 3.2 2.6-2.2L20 17" /></Svg>;
export const WeatherNavIcon = (p: IconProps) => <Svg {...p}><circle cx="9" cy="9" r="3" /><path d={rays(9, 9, 5, 6.6, [180, 225, 270, 315])} /><path d="M10.2 20h7.3a3.6 3.6 0 0 0 .6-7.15 5 5 0 0 0-9.5.9A3.2 3.2 0 0 0 10.2 20z" /></Svg>;
export const BulbIcon = (p: IconProps) => <Svg {...p}><path d="M9 17.5h6M10 20.5h4M12 3.5a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V17h5.2v-.7c0-.8.4-1.5 1-2A6 6 0 0 0 12 3.5z" /></Svg>;
export const CalendarIcon = (p: IconProps) => <Svg {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="2.4" /><path d="M3.5 10h17M8 3v4M16 3v4" /></Svg>;
export const GearIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></Svg>;
export const PlayIcon = (p: IconProps) => <Svg {...p}><path d="M8 5.5v13l10.5-6.5z" /></Svg>;
export const ChevronIcon = (p: IconProps) => <Svg {...p}><path d="m9.5 6 6 6-6 6" /></Svg>;
