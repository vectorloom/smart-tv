using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace SmartTv;

// All session transitions and command enqueueing share one lock. Socket writes have
// a single reader per peer; a slow peer is disconnected, never an unbounded queue.
public sealed class RemotePeer(string address)
{
    public string Address { get; } = address;
    public Channel<object> Outbox { get; } = Channel.CreateBounded<object>(32);
    public CancellationTokenSource Closed { get; } = new();
    public bool Authenticated { get; internal set; }
    internal DateTimeOffset Window;
    internal int Messages;
    internal void Send(object message) { if (!Outbox.Writer.TryWrite(message)) Closed.Cancel(); }
}

/// <summary>
/// Pairs a TV dashboard with one phone remote and relays commands. Credentials are 256-bit random
/// tokens handed to the browser once; the server keeps only their SHA-256 hashes. Paired sessions
/// (hashes and expiry, nothing else) are saved to <paramref name="sessionFile"/> when set, so a
/// restart or redeploy keeps phones paired; the 30-day expiry slides on every reconnect.
/// </summary>
public sealed class RemoteControl(TimeProvider clock, string? sessionFile = null, ILogger? logger = null) : IDisposable
{
    public RemoteControl(TimeProvider clock) : this(clock, null, null) { }

    private sealed class Session
    {
        public required string TvHash;
        public required DateTimeOffset Expires;
        public string? PhoneHash;
        public RemotePeer? Tv;
        public RemotePeer? Phone;
        public string? Code;
        public DateTimeOffset CodeExpires;
        public DateTimeOffset? OfflineSince;
    }
    private readonly object gate = new();
    private readonly List<Session> sessions = Load(sessionFile, clock, logger);
    private readonly Dictionary<string, (DateTimeOffset Start, int Count)> attempts = [];
    private readonly Dictionary<string, (DateTimeOffset Start, int Count)> connections = [];
    private ITimer? cleanup;
    // A paired TV and phone stay paired across reloads, TV power-offs, and phone sleeps while
    // either side reconnects at least once in this window. Unpaired TV sessions keep the short
    // offline grace and absolute lifetime: a reloaded TV simply registers again.
    public static readonly TimeSpan PairedLifetime = TimeSpan.FromDays(30);
    public static readonly TimeSpan OfflineGrace = TimeSpan.FromMinutes(2);
    private static void Renew(Session s, DateTimeOffset now)
    {
        if (s.PhoneHash != null && s.Expires < now + PairedLifetime) s.Expires = now + PairedLifetime;
    }
    private static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    private static bool Same(string? a, string b) => a != null && a.Length == b.Length &&
        CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(a), Encoding.ASCII.GetBytes(b));

    private sealed record StoredSession(string Tv, string Phone, DateTimeOffset Expires);
    private sealed record StoredSessions(int Version, StoredSession[] Sessions);

    private static List<Session> Load(string? file, TimeProvider clock, ILogger? logger)
    {
        if (string.IsNullOrEmpty(file) || !File.Exists(file)) return [];
        try
        {
            var stored = JsonSerializer.Deserialize<StoredSessions>(File.ReadAllText(file), JsonSerializerOptions.Web);
            var now = clock.GetUtcNow();
            static bool IsHash(string? value) => value is { Length: 64 } && value.All(Uri.IsHexDigit);
            return (stored?.Sessions ?? []).Where(s => s.Expires > now && IsHash(s.Tv) && IsHash(s.Phone))
                .Take(1000).Select(s => new Session { TvHash = s.Tv, PhoneHash = s.Phone, Expires = s.Expires }).ToList();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            logger?.LogWarning("Remote sessions could not be loaded ({Error}); phones must pair again.", error.GetType().Name);
            return [];
        }
    }

    // Called under the gate whenever the set of paired sessions or an expiry changes.
    private void Save()
    {
        if (string.IsNullOrEmpty(sessionFile)) return;
        try
        {
            var stored = new StoredSessions(1, sessions.Where(s => s.PhoneHash != null)
                .Select(s => new StoredSession(s.TvHash, s.PhoneHash!, s.Expires)).ToArray());
            var temporary = sessionFile + ".tmp";
            var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            using (var stream = new FileStream(temporary, options)) JsonSerializer.Serialize(stream, stored, JsonSerializerOptions.Web);
            File.Move(temporary, sessionFile, overwrite: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            logger?.LogWarning("Remote sessions could not be saved ({Error}); pairings last until the next restart.", error.GetType().Name);
        }
    }
    private static readonly HashSet<string> Commands = ["Up", "Down", "Left", "Right", "Select", "Back", "Home", "PlayPause", "Next", "Previous"];
    private static string Token() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    public void StartCleanup() => cleanup = clock.CreateTimer(_ => Tick(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
    public bool Connect(string address)
    {
        lock (gate) { Sweep(); return Allow(connections, address, 60, TimeSpan.FromMinutes(1)); }
    }
    private bool Allow(Dictionary<string, (DateTimeOffset Start, int Count)> limits, string key, int max, TimeSpan window)
    {
        var now = clock.GetUtcNow();
        if (!limits.TryGetValue(key, out var value) || now - value.Start >= window) value = (now, 0);
        limits[key] = (value.Start, value.Count + 1);
        return value.Count < max;
    }
    private void Sweep()
    {
        var now = clock.GetUtcNow();
        var changed = false;
        foreach (var s in sessions.ToArray())
        {
            if (now >= s.Expires || (s.PhoneHash == null && s.OfflineSince is {} offline && now - offline >= OfflineGrace))
            {
                s.Tv?.Send(new { type = "expired" }); s.Phone?.Send(new { type = "expired" }); sessions.Remove(s);
                changed |= s.PhoneHash != null;
            }
            else if (s.Code != null && now >= s.CodeExpires)
            { s.Code = null; s.Tv?.Send(new { type = "codeExpired" }); }
        }
        if (changed) Save();
        foreach (var limits in new[] { attempts, connections })
            foreach (var key in limits.Where(x => now - x.Value.Start >= TimeSpan.FromMinutes(1)).Select(x => x.Key).ToArray()) limits.Remove(key);
    }
    public void Tick() { lock (gate) Sweep(); }
    public void Handle(RemotePeer peer, string json)
    {
        lock (gate)
        {
            Sweep();
            var now = clock.GetUtcNow();
            if (now - peer.Window >= TimeSpan.FromSeconds(1)) { peer.Window = now; peer.Messages = 0; }
            if (++peer.Messages > 30) { peer.Closed.Cancel(); return; }
            JsonDocument doc;
            try { doc = JsonDocument.Parse(json); } catch (JsonException) { Error(peer, "Invalid message"); return; }
            using (doc)
            {
                var root = doc.RootElement;
                string? Field(string name) => root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                var type = Field("type");
                var session = sessions.FirstOrDefault(s => s.Tv == peer || s.Phone == peer);
                if (type == "register" && session == null && !peer.Authenticated)
                {
                    if (!Allow(attempts, peer.Address, 20, TimeSpan.FromMinutes(1)) || sessions.Count >= 1000) { Error(peer, "Try again in a minute"); return; }
                    var token = Token();
                    session = new Session { TvHash = Hash(token), Tv = peer, Expires = now.AddHours(12) };
                    sessions.Add(session); peer.Authenticated = true;
                    peer.Send(new { type = "ready", credential = token, role = "tv", connected = false }); return;
                }
                if ((type == "pair" || type == "resume") && session == null && !peer.Authenticated)
                {
                    if (!Allow(attempts, peer.Address, 20, TimeSpan.FromMinutes(1))) { Error(peer, "Try again in a minute"); return; }
                    var value = Field(type == "pair" ? "code" : "credential");
                    var hash = type == "resume" && value != null ? Hash(value) : "";
                    session = sessions.FirstOrDefault(s => value != null && (type == "pair"
                        ? s.Code == value && s.CodeExpires > now && s.Tv != null
                        : Same(s.TvHash, hash) || Same(s.PhoneHash, hash)));
                    if (session == null) { peer.Send(new { type = "denied", message = "Pairing or session expired. Pair again." }); return; }
                    var tv = type == "resume" && Same(session.TvHash, hash);
                    string? credential = type == "resume" ? value : null;
                    if (tv)
                    {
                        // Another tab (or a reloaded page whose old socket is still half-open) now owns
                        // this TV session. Tell the old one so it starts a fresh session instead of
                        // resuming in a loop; completing its outbox flushes the message, then closes.
                        if (session.Tv is { } previous && previous != peer) { previous.Send(new { type = "replaced" }); previous.Outbox.Writer.TryComplete(); }
                        session.Tv = peer; session.OfflineSince = null;
                    }
                    else
                    {
                        session.Phone?.Send(new { type = "revoked" });
                        session.Phone = peer;
                        if (type == "pair") { credential = Token(); session.PhoneHash = Hash(credential); session.Code = null; }
                    }
                    Renew(session, now);
                    if (session.PhoneHash != null) Save();
                    peer.Authenticated = true;
                    peer.Send(new { type = "ready", credential, role = tv ? "tv" : "phone", connected = tv ? session.Phone != null : session.Tv != null });
                    Status(session); return;
                }
                if (type == "ping") { peer.Send(new { type = "pong" }); return; }
                if (session == null) { Error(peer, "Pairing required"); return; }
                if (type == "code" && session.Tv == peer)
                {
                    do { session.Code = RandomNumberGenerator.GetInt32(10000000, 100000000).ToString(); }
                    while (sessions.Any(s => s != session && s.Code == session.Code));
                    session.CodeExpires = now.AddMinutes(2);
                    peer.Send(new { type = "code", code = session.Code, expires = session.CodeExpires }); return;
                }
                if (type == "unpair")
                {
                    session.Phone?.Send(new { type = "revoked" });
                    var wasPaired = session.PhoneHash != null;
                    session.Phone = null; session.PhoneHash = null; session.Code = null;
                    session.Tv?.Send(new { type = "codeExpired" }); Status(session);
                    if (wasPaired) Save();
                    return;
                }
                if (type == "forget" && session.Tv == peer)
                {
                    // "Unpair this TV": end the TV's session entirely; the TV page then registers afresh.
                    session.Phone?.Send(new { type = "revoked" });
                    sessions.Remove(session);
                    if (session.PhoneHash != null) Save();
                    peer.Authenticated = false;
                    peer.Send(new { type = "forgotten" }); return;
                }
                if (type == "command" && session.Phone == peer)
                {
                    var command = Field("command");
                    if (command == null || !Commands.Contains(command)) { Error(peer, "Unknown command"); return; }
                    if (session.Tv == null) { Error(peer, "TV disconnected; command not sent"); return; }
                    session.Tv.Send(new { type = "command", command }); return;
                }
                Error(peer, "Unsupported operation");
            }
        }
    }
    private static void Error(RemotePeer p, string message) => p.Send(new { type = "error", message });
    /// <summary>The User-Agent, limited to printable ASCII and 256 characters so it cannot forge log lines.</summary>
    public static string UserAgent(HttpContext context)
    {
        var raw = context.Request.Headers.UserAgent.ToString();
        if (raw.Length == 0) return "(none)";
        var clean = new string(raw.Take(256).Select(c => c is >= ' ' and <= '~' ? c : '?').ToArray());
        return raw.Length > 256 ? clean + "…" : clean;
    }
    private static void Status(Session s)
    {
        s.Tv?.Send(new { type = "status", connected = s.Phone != null, paired = s.PhoneHash != null, codeActive = s.Code != null });
        s.Phone?.Send(new { type = "status", connected = s.Tv != null, paired = true });
    }
    public void Disconnect(RemotePeer peer)
    {
        lock (gate)
        {
            foreach (var s in sessions)
            {
                if (s.Tv != peer && s.Phone != peer) continue;
                if (s.Tv == peer) { s.Tv = null; s.OfflineSince = clock.GetUtcNow(); }
                if (s.Phone == peer) s.Phone = null;
                Status(s);
            }
        }
    }
    public void Dispose() => cleanup?.Dispose();

    public static async Task Endpoint(HttpContext context, RemoteControl control)
    {
        // Browser-origin enforcement also blocks cross-site WebSocket hijacking.
        var origin = context.Request.Headers.Origin.ToString();
        if (!context.WebSockets.IsWebSocketRequest || origin != $"{context.Request.Scheme}://{context.Request.Host}")
        { context.Response.StatusCode = 403; return; }
        if (!control.Connect(context.Connection.RemoteIpAddress?.ToString() ?? "unknown"))
        { context.Response.StatusCode = 429; return; }
        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        var peer = new RemotePeer(context.Connection.RemoteIpAddress?.ToString() ?? "unknown");
        // One line per connection, so a TV box's browser can be identified from the server log.
        context.RequestServices.GetService<ILogger<RemoteControl>>()?.LogInformation(
            "Remote connection from {Address}; User-Agent: {UserAgent}", peer.Address, UserAgent(context));
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, peer.Closed.Token);
        var ct = lifetime.Token;
        var send = Task.Run(async () => {
            await foreach (var message in peer.Outbox.Reader.ReadAllAsync(ct))
                await socket.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(message)), WebSocketMessageType.Text, true, ct);
        }, ct);
        try
        {
            var buffer = new byte[1024];
            while (!ct.IsCancellationRequested)
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                deadline.CancelAfter(TimeSpan.FromSeconds(45));
                var length = 0;
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer, length, buffer.Length - length), deadline.Token);
                    if (result.MessageType != WebSocketMessageType.Text) return;
                    length += result.Count;
                    if (length >= buffer.Length) return;
                } while (!result.EndOfMessage);
                control.Handle(peer, Encoding.UTF8.GetString(buffer, 0, length));
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException) { }
        finally
        {
            control.Disconnect(peer); lifetime.Cancel();
            try { await send; } catch (Exception e) when (e is WebSocketException or OperationCanceledException) { }
            using var closing = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            try {
                if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "Connection ended", closing.Token);
            } catch (Exception e) when (e is WebSocketException or OperationCanceledException) { socket.Abort(); }
            peer.Closed.Dispose();
        }
    }
}
