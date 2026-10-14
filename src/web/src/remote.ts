import { useEffect, useRef, useState } from 'react';

export type Command = 'Up' | 'Down' | 'Left' | 'Right' | 'Select' | 'Back' | 'Home' | 'PlayPause' | 'Next' | 'Previous';
export function useRemote(role: 'tv' | 'phone', onCommand?: (command: Command) => void) {
  const [status, setStatus] = useState('Connecting…');
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [paired, setPaired] = useState(false);
  const [code, setCode] = useState('');
  const [expires, setExpires] = useState('');
  const socket = useRef<WebSocket | null>(null);
  // Memory only: no URL, cookies, localStorage, or cross-tab credential sharing.
  const credential = useRef('');
  const callback = useRef(onCommand); callback.current = onCommand;
  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout>;
    let heartbeat: ReturnType<typeof setInterval>;
    let delay = 500;
    let lastMessage = Date.now();
    function connect() {
      if (disposed) return;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/remote`);
      socket.current = ws;
      ws.onopen = () => {
        lastMessage = Date.now();
        if (credential.current) ws.send(JSON.stringify({ type: 'resume', credential: credential.current }));
        else if (role === 'tv') ws.send(JSON.stringify({ type: 'register' }));
        else { setReady(true); setStatus('Enter the code shown on your TV'); }
        // Unpaired phones reconnect when needed, without keeping idle server sockets.
        heartbeat = setInterval(() => {
          if (Date.now() - lastMessage > 40000) { ws.close(); return; }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, 15000);
      };
      ws.onmessage = event => {
        if (disposed) return;
        lastMessage = Date.now();
        const message = JSON.parse(event.data);
        if (message.type === 'ready') {
          credential.current = message.credential; setReady(true); delay = 500;
          setConnected(message.connected); setPaired(role === 'phone' || message.connected);
          setStatus(message.connected ? 'Connected' : role === 'tv' ? 'No phone connected' : 'TV disconnected');
        } else if (message.type === 'status') {
          setConnected(message.connected); setPaired(message.paired);
          setStatus(message.connected ? 'Connected' : role === 'tv' ? (message.paired ? 'Phone disconnected' : 'No phone connected') : 'TV disconnected');
          if (message.codeActive === false) setCode('');
        } else if (message.type === 'code') { setCode(message.code); setExpires(message.expires); }
        else if (message.type === 'codeExpired') setCode('');
        else if (message.type === 'command') callback.current?.(message.command);
        else if (['revoked', 'expired', 'denied'].includes(message.type)) {
          credential.current = ''; setPaired(false); setConnected(false); setCode('');
          setStatus(message.message || 'Session ended. Pair again.');
          ws.close();
        } else if (message.type === 'error') {
          setStatus(message.message);
          if (role === 'tv' && !credential.current) ws.close();
        }
      };
      ws.onclose = () => {
        clearInterval(heartbeat);
        if (disposed) return;
        setReady(false); setConnected(false); setCode('');
        setStatus(credential.current ? 'Reconnecting…' : 'Disconnected — reconnecting…');
        retry = setTimeout(connect, delay); delay = Math.min(delay * 2, 10000);
      };
    }
    connect();
    return () => { disposed = true; clearTimeout(retry); clearInterval(heartbeat); socket.current?.close(); };
  }, [role]);
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(() => setCode(''), Math.max(0, Date.parse(expires) - Date.now()));
    return () => clearTimeout(timer);
  }, [code, expires]);
  function send(message: object) {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }
  return { status, ready, connected, paired, code, send };
}
