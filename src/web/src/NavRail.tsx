import { forwardRef, type ComponentType } from 'react';
import { BulbIcon, CalendarIcon, GearIcon, HomeIcon, PhotosIcon, WeatherNavIcon } from './icons';

export type NavItem = { path: string; label: string; Icon: ComponentType<{ className?: string }> };

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Home', Icon: HomeIcon },
  { path: '/photos', label: 'Photos', Icon: PhotosIcon },
  { path: '/weather', label: 'Weather', Icon: WeatherNavIcon },
  { path: '/home-automation', label: 'Home automation', Icon: BulbIcon },
  { path: '/calendar', label: 'Calendar', Icon: CalendarIcon },
  { path: '/preferences', label: 'Settings', Icon: GearIcon },
];

/** The rail item for a path: "/photos/abc" belongs to Photos. */
export function sectionOf(pathname: string): string {
  return NAV_ITEMS.find(item => item.path !== '/' && (pathname === item.path || pathname.startsWith(`${item.path}/`)))?.path ?? '/';
}

/**
 * Left navigation. On home it is hidden and slides in expanded on the first key, hiding again after
 * 30 s idle. On other screens it stays collapsed at 112 px (icons only) and expands over the content
 * while it has focus. Items are plain buttons so D-pad, Enter, mouse and touch all work the same.
 */
export const NavRail = forwardRef<HTMLElement, {
  pathname: string; mode: 'hidden' | 'overlay' | 'collapsed'; onNavigate: (path: string) => void;
}>(function NavRail({ pathname, mode, onNavigate }, ref) {
  const section = sectionOf(pathname);
  return <nav className={`nav-rail is-${mode}`} ref={ref} aria-label="Main" inert={mode === 'hidden'}>
    <ul>
      {NAV_ITEMS.map(({ path, label, Icon }) => <li key={path}>
        <button className="nav-item" data-focus-key={`nav:${path}`} aria-current={section === path ? 'page' : undefined}
          aria-label={label} onClick={() => onNavigate(path)}>
          <Icon className="nav-icon" /><span className="nav-label">{label}</span>
        </button>
      </li>)}
    </ul>
  </nav>;
});
