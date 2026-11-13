import { useEffect, useState } from 'react';

const dateFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export function formatClock(date: Date): { time: string; period: 'AM' | 'PM' } {
  const hours = date.getHours();
  return { time: `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}`, period: hours < 12 ? 'AM' : 'PM' };
}

/** Large wall clock. Ticks every second so the minute flips on time; seconds are not shown. */
export function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const { time, period } = formatClock(now);
  return <div className="clock">
    <div className="clock-time"><time dateTime={now.toISOString()}>{time}</time><span className="clock-period">{period}</span></div>
    <div className="clock-date">{dateFormat.format(now)}</div>
  </div>;
}
