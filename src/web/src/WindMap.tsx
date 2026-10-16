import { useEffect, useRef, useState } from 'react';
import { getRegionalWind, type RegionalWind } from './api';

const refreshEvery = 7 * 60 * 1000;
const directionName = (degrees: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(degrees / 45) % 8];

export function WindMap({ location, speedMph, directionDegrees }: { location: string; speedMph: number; directionDegrees: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLElement>(null);
  const [wind, setWind] = useState<RegionalWind | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const next = await getRegionalWind(controller.signal);
        if (active) { setWind(next); setFailed(false); }
      } catch {
        if (active && !controller.signal.aborted) {
          setFailed(true);
          setWind(previous => previous ? { ...previous, stale: true } : null);
        }
      } finally { if (active) setLoading(false); }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, refreshEvery);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const element = host.current;
    const canvasElement = canvas.current;
    const data = wind;
    const context = canvasElement?.getContext('2d');
    if (!element || !canvasElement || !context || !data || data.points.length < 9) return;

    let visible = false;
    let frame = 0;
    let width = 0;
    let height = 0;
    let previousFrameTime = 0;
    let resizeObserver: ResizeObserver | undefined;
    const lats = [...new Set(data.points.map(point => point.latitude))].sort((a, b) => a - b);
    const lons = [...new Set(data.points.map(point => point.longitude))].sort((a, b) => a - b);
    const speedMax = Math.max(1, ...data.points.map(point => point.windSpeedMph));
    const grid = new Map(data.points.map(point => [`${point.latitude},${point.longitude}`, point]));
    const particles = Array.from({ length: 230 }, (_, index) => ({
      x: ((index * 0.61803398875) % 1), y: ((index * 0.75487766625) % 1),
      tailLength: 42 + ((index * 0.38196601125) % 1) * 42,
    }));
    const size = () => {
      const rect = element.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      canvasElement.width = Math.round(width * ratio); canvasElement.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = '#101719'; context.fillRect(0, 0, width, height);
    };
    const bracket = (values: number[], target: number): [number, number, number] => {
      if (target <= values[0]) return [values[0], values[0], 0];
      const last = values.length - 1;
      if (target >= values[last]) return [values[last], values[last], 0];
      for (let index = 0; index < last; index++) {
        if (target <= values[index + 1]) {
          const amount = (target - values[index]) / (values[index + 1] - values[index]);
          return [values[index], values[index + 1], amount];
        }
      }
      return [values[last], values[last], 0];
    };
    const sample = (x: number, y: number) => {
      const lat = lats[lats.length - 1] - y * (lats[lats.length - 1] - lats[0]);
      const lon = lons[0] + x * (lons[lons.length - 1] - lons[0]);
      const [lat0, lat1, fy] = bracket(lats, lat);
      const [lon0, lon1, fx] = bracket(lons, lon);
      const corners = [grid.get(`${lat0},${lon0}`), grid.get(`${lat0},${lon1}`), grid.get(`${lat1},${lon0}`), grid.get(`${lat1},${lon1}`)];
      if (corners.some(point => !point || !Number.isFinite(point.windSpeedMph) || !Number.isFinite(point.windDirectionDegrees) ||
          point.windSpeedMph < 0 || point.windDirectionDegrees < 0 || point.windDirectionDegrees >= 360)) return null;
      const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      let east = 0; let north = 0;
      for (let index = 0; index < corners.length; index++) {
        const point = corners[index]!;
        const to = (point.windDirectionDegrees + 180) * Math.PI / 180;
        east += Math.sin(to) * point.windSpeedMph * weights[index];
        north += Math.cos(to) * point.windSpeedMph * weights[index];
      }
      return { east, north, speed: Math.hypot(east, north) };
    };
    const paint = () => {
      if (!visible || document.hidden) { frame = 0; return; }
      const now = performance.now();
      const elapsed = previousFrameTime ? Math.min(40, now - previousFrameTime) : 16.67;
      previousFrameTime = now;
      context.fillStyle = `rgba(12, 20, 23, ${1 - Math.exp(-elapsed / 1250)})`; context.fillRect(0, 0, width, height);
      const trails: Array<Array<[number, number, number, number, number, number, number, number]>> = [[], [], []];
      const heads: Array<Array<[number, number, number, number]>> = [[], [], []];
      for (const particle of particles) {
        const startVector = sample(particle.x, particle.y);
        if (!startVector || startVector.speed < 0.01) continue;
        const startIntensity = Math.min(1, startVector.speed / speedMax);
        const startSpeed = 16 + 62 * startIntensity;
        const startEast = startVector.east / startVector.speed;
        const startNorth = -startVector.north / startVector.speed;
        const middleX = particle.x + startEast * startSpeed * elapsed / 2000 / width;
        const middleY = particle.y + startNorth * startSpeed * elapsed / 2000 / height;
        const middleVector = sample(middleX, middleY);
        if (!middleVector || middleVector.speed < 0.01) continue;
        const middleIntensity = Math.min(1, middleVector.speed / speedMax);
        const speed = 16 + 62 * middleIntensity;
        const east = middleVector.east / middleVector.speed;
        const north = -middleVector.north / middleVector.speed;
        const dx = east * speed * elapsed / 1000;
        const dy = north * speed * elapsed / 1000;
        const nextX = particle.x + dx / width;
        const nextY = particle.y + dy / height;
        const endVector = sample(nextX, nextY);
        if (!endVector || endVector.speed < 0.01) continue;
        const intensity = Math.min(1, endVector.speed / speedMax);
        const band = intensity < .34 ? 0 : intensity < .68 ? 1 : 2;
        const nextPx = nextX * width; const nextPy = nextY * height;
        const tailX = nextPx - endVector.east / endVector.speed * particle.tailLength;
        const tailY = nextPy + endVector.north / endVector.speed * particle.tailLength;
        const tailVector = tailX >= 0 && tailX <= width && tailY >= 0 && tailY <= height
          ? sample(tailX / width, tailY / height) : null;
        if (tailVector && tailVector.speed >= 0.01) {
          const tailEast = tailVector.east / tailVector.speed;
          const tailNorth = -tailVector.north / tailVector.speed;
          trails[band].push([
            tailX, tailY,
            tailX + tailEast * particle.tailLength / 3, tailY + tailNorth * particle.tailLength / 3,
            nextPx - east * particle.tailLength / 3, nextPy + north * particle.tailLength / 3,
            nextPx, nextPy,
          ]);
        }
        // A small arrowhead makes the moving streak read as airflow and points
        // along the sampled vector instead of implying a decorative direction.
        heads[band].push([nextPx, nextPy, Math.atan2(north, east), 3.2 + intensity * 1.2]);
        particle.x = nextX; particle.y = nextY;
        if (particle.x < 0 || particle.x > 1 || particle.y < 0 || particle.y > 1) {
          particle.x = (particle.x + 1) % 1; particle.y = (particle.y + 1) % 1;
        }
      }
      const colors = ['rgba(43, 145, 189, .58)', 'rgba(47, 190, 213, .78)', 'rgba(255, 181, 71, .88)'];
      for (let band = 0; band < trails.length; band++) {
        if (trails[band].length) {
          context.beginPath();
          for (const [x0, y0, cx0, cy0, cx1, cy1, x1, y1] of trails[band]) {
            context.moveTo(x0, y0); context.bezierCurveTo(cx0, cy0, cx1, cy1, x1, y1);
          }
          context.strokeStyle = colors[band]; context.lineWidth = band === 2 ? 2.2 : 1.65; context.lineCap = 'round'; context.stroke();
        }
        if (heads[band].length) {
          context.beginPath();
          for (const [x, y, angle, size] of heads[band]) {
            const backX = x - Math.cos(angle) * size;
            const backY = y - Math.sin(angle) * size;
            const sideX = Math.sin(angle) * size * .62;
            const sideY = -Math.cos(angle) * size * .62;
            context.moveTo(backX - sideX, backY - sideY);
            context.lineTo(x, y);
            context.lineTo(backX + sideX, backY + sideY);
          }
          context.strokeStyle = colors[band]; context.lineWidth = band === 2 ? 1.8 : 1.35; context.lineCap = 'round'; context.lineJoin = 'round'; context.stroke();
        }
      }
      const mx = width / 2; const my = height / 2;
      context.beginPath(); context.moveTo(mx - 7, my - 3); context.arc(mx, my - 3, 7, Math.PI, 0); context.lineTo(mx, my + 11); context.closePath();
      context.fillStyle = '#ffb547'; context.fill();
      context.beginPath(); context.arc(mx, my - 4, 2.6, 0, Math.PI * 2); context.fillStyle = '#172024'; context.fill();
      frame = window.requestAnimationFrame(paint);
    };
    const start = () => {
      if (visible && !document.hidden && frame === 0) { previousFrameTime = 0; frame = window.requestAnimationFrame(paint); }
    };
    const onVisibility = () => {
      if (document.hidden && frame) { window.cancelAnimationFrame(frame); frame = 0; previousFrameTime = 0; }
      else start();
    };
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (visible) start(); else if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
    });
    observer.observe(element);
    resizeObserver = new ResizeObserver(() => { size(); });
    resizeObserver.observe(element);
    size();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      observer.disconnect(); resizeObserver?.disconnect(); document.removeEventListener('visibilitychange', onVisibility);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [wind]);

  const stale = !!wind && (wind.stale || failed);
  const flowDirection = directionName(directionDegrees + 180);
  return <section className="weather-wind-map" ref={host} data-grid-points={wind?.points.length ?? 0} aria-label={`${location} regional wind map. Current wind ${Math.round(speedMph)} miles per hour from ${directionName(directionDegrees)}, flowing toward ${flowDirection}.`}>
    <canvas className="weather-wind-canvas" ref={canvas} aria-hidden="true" />
    <div className="weather-map-cities" aria-hidden="true">
      <span className="weather-map-city is-denton">Denton</span>
      <span className="weather-map-city is-plano">Plano</span>
      <span className="weather-map-city is-fort-worth">Fort Worth</span>
      <span className="weather-map-city is-arlington">Arlington</span>
      <span className="weather-map-city is-dallas">Dallas</span>
    </div>
    <div className="weather-map-top"><div><span className="weather-map-kicker">REGIONAL CONDITIONS</span><h3>Wind map</h3>
      <p>{location} · {Math.round(speedMph)} mph from {directionName(directionDegrees)} <span className="weather-map-flow"><span aria-hidden="true" style={{ transform: `rotate(${(directionDegrees + 180) % 360}deg)` }}>↑</span> FLOW {flowDirection}</span></p></div>
      {stale && <span className="weather-map-status is-stale">STALE</span>}
    </div>
    <div className="weather-map-bottom">
      <span className="weather-map-marker">● {location}</span>
      <span className="weather-map-legend"><b>WIND SPEED</b><i /> 0 <i /> {Math.round(speedMaxSafe(wind))} mph</span>
      {!wind && <span className="weather-map-status">{loading ? 'LOADING WIND GRID…' : 'WIND MAP UNAVAILABLE · RETRYING'}</span>}
    </div>
    {wind && <span className="weather-map-time">{stale ? 'STALE · ' : ''}GRID {wind.validTime}</span>}
  </section>;
}

function speedMaxSafe(wind: RegionalWind | null): number {
  return wind ? Math.max(1, Math.ceil(Math.max(...wind.points.map(point => point.windSpeedMph)))) : 0;
}
