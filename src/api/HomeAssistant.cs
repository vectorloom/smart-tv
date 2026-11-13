using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace SmartTv;

public sealed partial record HomeAssistantSettings(Uri BaseUrl, string Token, string[] EntityIds, string Revision = "")
{
    public override string ToString() => "HomeAssistantSettings (credentials redacted)";
    /// <summary>Lights and switches can be toggled from the TV; climate entities are shown read-only.</summary>
    public static readonly string[] ToggleDomains = ["light", "switch"];
    public static readonly string[] DisplayDomains = ["climate"];
    public static bool IsSelectable(string entityId) => IsEntityId(entityId) && (ToggleDomains.Contains(Domain(entityId)) || DisplayDomains.Contains(Domain(entityId)));
    public static bool IsToggleable(string entityId) => IsEntityId(entityId) && ToggleDomains.Contains(Domain(entityId));
    public static string Domain(string entityId) => entityId[..entityId.IndexOf('.')];
    public static bool IsEntityId(string? value) => value is { Length: > 2 and <= 255 } && EntityIdPattern().IsMatch(value);
    [GeneratedRegex("^[a-z0-9_]+\\.[a-z0-9_]+$")] private static partial Regex EntityIdPattern();
}

public sealed record SaveHomeAssistantRequest(string Revision, string BaseUrl, string? ReplacementToken, string[] EntityIds);
public sealed record HomeAssistantEntityOption(string Id, string Domain, string Name, string State);

/// <summary>What the TV browser receives: sanitized fields only, never attributes wholesale and never the token.</summary>
public sealed record HomeEntity(string Id, string Domain, string Name, string State, bool Available, bool On, bool Toggleable,
    int? Brightness = null, double? CurrentTemperature = null, double? TargetTemperature = null, double? TargetLow = null,
    double? TargetHigh = null, string? HvacAction = null, string? Unit = null);
/// <summary>Status: not-configured, connecting, live, or offline (entities then show the last known state).</summary>
public sealed record HomeSnapshot(string Status, string? Message, HomeEntity[] Entities);

/// <summary>
/// One authenticated Home Assistant WebSocket session. The socket is opened through the deployment's
/// pinned-IP handler, so it can only reach an approved Home Assistant address. <see cref="Run"/> is the
/// single reader: it routes command results to their callers and subscription events to a callback.
/// </summary>
public sealed class HomeAssistantConnection : IAsyncDisposable
{
    private const int MessageLimit = 16 * 1024 * 1024;
    private readonly ClientWebSocket socket;
    private readonly SemaphoreSlim sendLock = new(1, 1);
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonElement>> pending = new();
    private int nextId;
    private volatile bool closed;
    public string Version { get; private set; } = "";

    private HomeAssistantConnection(ClientWebSocket socket) => this.socket = socket;

    public static Uri SocketUri(Uri apiBase) =>
        new UriBuilder(new Uri(apiBase, "websocket")) { Scheme = apiBase.Scheme == "https" ? "wss" : "ws" }.Uri;

    public static async Task<HomeAssistantConnection> Open(Uri apiBase, string token, HttpMessageInvoker invoker, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(token)) throw new DashboardException(503, "Enter a Home Assistant access token in the administrator settings.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(15));
        var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        var connection = new HomeAssistantConnection(socket);
        try
        {
            await socket.ConnectAsync(SocketUri(apiBase), invoker, deadline.Token);
            using (var hello = await connection.ReceiveOne(deadline.Token))
                if (hello?.RootElement.GetProperty("type").GetString() != "auth_required") throw new JsonException("Unexpected Home Assistant greeting.");
            await connection.SendRaw(new Dictionary<string, object?> { ["type"] = "auth", ["access_token"] = token }, deadline.Token);
            using var reply = await connection.ReceiveOne(deadline.Token) ?? throw new WebSocketException("Home Assistant closed the connection.");
            switch (reply.RootElement.GetProperty("type").GetString())
            {
                case "auth_ok":
                    connection.Version = reply.RootElement.TryGetProperty("ha_version", out var version) ? version.GetString() ?? "" : "";
                    return connection;
                case "auth_invalid":
                    throw new DashboardException(400, "Home Assistant rejected the access token. Create a new long-lived token for the dashboard user.");
                default:
                    throw new JsonException("Unexpected Home Assistant authentication reply.");
            }
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    private async Task<JsonDocument?> ReceiveOne(CancellationToken ct)
    {
        var buffer = new ArrayBufferWriter<byte>(16 * 1024);
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer.GetMemory(16 * 1024), ct);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            buffer.Advance(result.Count);
            if (buffer.WrittenCount > MessageLimit) throw new DashboardException(502, "Home Assistant response exceeds the size limit.");
            if (result.EndOfMessage) return JsonDocument.Parse(buffer.WrittenMemory);
        }
    }

    private async Task SendRaw(Dictionary<string, object?> payload, CancellationToken ct)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload);
        await sendLock.WaitAsync(ct);
        try { await socket.SendAsync(bytes, WebSocketMessageType.Text, true, ct); }
        finally { sendLock.Release(); }
    }

    /// <summary>Sends one command and waits for its result. Requires <see cref="Run"/> to be reading.</summary>
    public async Task<JsonElement> Command(string type, Dictionary<string, object?>? fields, TimeSpan timeout, CancellationToken ct)
    {
        var id = Interlocked.Increment(ref nextId);
        var reply = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = reply;
        try
        {
            if (closed) throw new DashboardException(503, "Home Assistant is not connected.");
            var payload = new Dictionary<string, object?>(fields ?? []) { ["id"] = id, ["type"] = type };
            await SendRaw(payload, ct);
            return await reply.Task.WaitAsync(timeout, ct);
        }
        catch (TimeoutException) { throw new DashboardException(504, "Home Assistant did not answer in time."); }
        finally { pending.TryRemove(id, out _); }
    }

    /// <summary>Reads until the socket closes or <paramref name="ct"/> is cancelled; always ends by failing waiting commands.</summary>
    public async Task Run(Action<JsonElement> onEvent, CancellationToken ct)
    {
        try
        {
            while (true)
            {
                using var message = await ReceiveOne(ct) ?? throw new WebSocketException("Home Assistant closed the connection.");
                var root = message.RootElement;
                var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;
                if (type == "event" && root.TryGetProperty("event", out var payload)) { onEvent(payload); continue; }
                if (!root.TryGetProperty("id", out var idElement) || !idElement.TryGetInt32(out var id) || !pending.TryGetValue(id, out var reply)) continue;
                if (type == "pong") reply.TrySetResult(default);
                else if (type == "result")
                {
                    if (root.TryGetProperty("success", out var success) && success.ValueKind == JsonValueKind.True)
                        reply.TrySetResult(root.TryGetProperty("result", out var result) ? result.Clone() : default);
                    else
                    {
                        var code = root.TryGetProperty("error", out var error) && error.TryGetProperty("code", out var c) ? c.GetString() : null;
                        reply.TrySetException(code == "unauthorized"
                            ? new DashboardException(403, "The Home Assistant dashboard user is not allowed to do that.")
                            : new DashboardException(502, "Home Assistant could not complete the request."));
                    }
                }
            }
        }
        finally
        {
            closed = true;
            foreach (var reply in pending.Values) reply.TrySetException(new DashboardException(503, "Home Assistant disconnected."));
        }
    }

    public async ValueTask DisposeAsync()
    {
        closed = true;
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                using var quick = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, quick.Token);
            }
        }
        catch (Exception error) when (error is WebSocketException or OperationCanceledException or ObjectDisposedException) { }
        socket.Dispose();
        sendLock.Dispose();
    }
}

/// <summary>
/// Entity state built from <c>subscribe_entities</c> events. Home Assistant's frontend uses the same
/// compressed format: <c>a</c> adds full states (<c>s</c> state, <c>a</c> attributes), <c>c</c> carries
/// changes (<c>+</c> sets state/attributes, <c>-</c> lists removed attribute names), <c>r</c> removes entities.
/// Only allowlisted entities are kept, whatever the server sends.
/// </summary>
public sealed class HomeAssistantEntities
{
    private sealed class Entry
    {
        public string State = "unknown";
        public Dictionary<string, JsonElement> Attributes = [];
    }
    private readonly Dictionary<string, Entry> entries = [];

    public void Clear() => entries.Clear();
    public string? StateOf(string id) => entries.TryGetValue(id, out var entry) ? entry.State : null;

    public bool Apply(JsonElement message, IReadOnlySet<string> allowed)
    {
        if (message.ValueKind != JsonValueKind.Object) return false;
        var changed = false;
        if (message.TryGetProperty("a", out var added) && added.ValueKind == JsonValueKind.Object)
            foreach (var item in added.EnumerateObject())
            {
                if (!allowed.Contains(item.Name) || item.Value.ValueKind != JsonValueKind.Object) continue;
                var entry = new Entry();
                if (item.Value.TryGetProperty("s", out var state) && state.ValueKind == JsonValueKind.String) entry.State = state.GetString()!;
                if (item.Value.TryGetProperty("a", out var attributes) && attributes.ValueKind == JsonValueKind.Object)
                    foreach (var attribute in attributes.EnumerateObject()) entry.Attributes[attribute.Name] = attribute.Value.Clone();
                entries[item.Name] = entry;
                changed = true;
            }
        if (message.TryGetProperty("c", out var changes) && changes.ValueKind == JsonValueKind.Object)
            foreach (var item in changes.EnumerateObject())
            {
                if (!entries.TryGetValue(item.Name, out var entry) || item.Value.ValueKind != JsonValueKind.Object) continue;
                if (item.Value.TryGetProperty("+", out var plus) && plus.ValueKind == JsonValueKind.Object)
                {
                    if (plus.TryGetProperty("s", out var state) && state.ValueKind == JsonValueKind.String) entry.State = state.GetString()!;
                    if (plus.TryGetProperty("a", out var attributes) && attributes.ValueKind == JsonValueKind.Object)
                        foreach (var attribute in attributes.EnumerateObject()) entry.Attributes[attribute.Name] = attribute.Value.Clone();
                }
                if (item.Value.TryGetProperty("-", out var minus) && minus.ValueKind == JsonValueKind.Object &&
                    minus.TryGetProperty("a", out var removed) && removed.ValueKind == JsonValueKind.Array)
                    foreach (var name in removed.EnumerateArray()) if (name.ValueKind == JsonValueKind.String) entry.Attributes.Remove(name.GetString()!);
                changed = true;
            }
        if (message.TryGetProperty("r", out var gone) && gone.ValueKind == JsonValueKind.Array)
            foreach (var id in gone.EnumerateArray())
                if (id.ValueKind == JsonValueKind.String && entries.Remove(id.GetString()!)) changed = true;
        return changed;
    }

    private static string Cap(string value, int length) => value.Length <= length ? value : value[..length];
    private static double? Number(Dictionary<string, JsonElement> attributes, string name) =>
        attributes.TryGetValue(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number) ? number : null;
    private static string? Text(Dictionary<string, JsonElement> attributes, string name, int length) =>
        attributes.TryGetValue(name, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } text ? Cap(text.Trim(), length) : null;

    public HomeEntity Describe(string id, string? temperatureUnit)
    {
        var domain = HomeAssistantSettings.Domain(id);
        var toggleable = HomeAssistantSettings.IsToggleable(id);
        if (!entries.TryGetValue(id, out var entry)) return new(id, domain, id, "unavailable", false, false, toggleable);
        var state = Cap(entry.State, 64);
        var available = state is not ("unavailable" or "unknown");
        var name = Text(entry.Attributes, "friendly_name", 80) ?? id;
        if (domain == "climate")
            return new(id, domain, name, state, available, available && state != "off", false,
                CurrentTemperature: Number(entry.Attributes, "current_temperature"), TargetTemperature: Number(entry.Attributes, "temperature"),
                TargetLow: Number(entry.Attributes, "target_temp_low"), TargetHigh: Number(entry.Attributes, "target_temp_high"),
                HvacAction: Text(entry.Attributes, "hvac_action", 32), Unit: temperatureUnit);
        var on = state == "on";
        int? brightness = domain == "light" && on && Number(entry.Attributes, "brightness") is { } raw
            ? (int)Math.Clamp(Math.Round(raw / 255 * 100), 1, 100) : null;
        return new(id, domain, name, state, available, on, toggleable, brightness);
    }
}

public sealed record HomeAssistantOptions(TimeSpan SettingsPoll, TimeSpan Heartbeat, TimeSpan[] Backoff)
{
    public static readonly HomeAssistantOptions Default = new(TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(30),
        [TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(30)]);
}

/// <summary>A TV browser's live feed: always the latest snapshot, never a backlog.</summary>
public sealed class HomeSubscription(ChannelReader<HomeSnapshot> reader, Action dispose) : IDisposable
{
    public ChannelReader<HomeSnapshot> Reader { get; } = reader;
    public void Dispose() => dispose();
}

/// <summary>
/// Keeps one Home Assistant WebSocket open for the TV process, subscribed to the selected entities only,
/// and fans the resulting state out to every TV browser. The token stays here. Saved settings are
/// re-read every <see cref="HomeAssistantOptions.SettingsPoll"/>: a new revision reconnects at once.
/// While disconnected, the last known states stay on screen marked offline, and it retries with backoff.
/// </summary>
public sealed class HomeAssistantHub(SettingsStore store, HomeAssistantTargets targets, ILogger<HomeAssistantHub> logger, HomeAssistantOptions? options = null) : BackgroundService
{
    public const int MaxSubscribers = 32;
    private readonly HomeAssistantOptions options = options ?? HomeAssistantOptions.Default;
    private readonly object gate = new();
    private readonly HomeAssistantEntities entities = new();
    private readonly List<Channel<HomeSnapshot>> subscribers = [];
    private readonly Queue<long> toggles = new();
    private HomeSnapshot snapshot = new("connecting", "Connecting to Home Assistant…", []);
    private HomeAssistantSettings? active;
    private HashSet<string> allowed = [];
    private HomeAssistantConnection? connection;
    private string? unit;

    public HomeSnapshot Snapshot { get { lock (gate) return snapshot; } }

    public HomeSubscription Subscribe()
    {
        var channel = Channel.CreateBounded<HomeSnapshot>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropOldest });
        lock (gate)
        {
            if (subscribers.Count >= MaxSubscribers) throw new DashboardException(503, "Too many screens are following Home Assistant.");
            subscribers.Add(channel);
            channel.Writer.TryWrite(snapshot);
        }
        return new(channel.Reader, () => { lock (gate) subscribers.Remove(channel); channel.Writer.TryComplete(); });
    }

    // Callers hold the lock.
    private void Publish(string status, string? message)
    {
        var list = active?.EntityIds.Select(id => entities.Describe(id, unit)).ToArray() ?? [];
        snapshot = new(status, message, list);
        foreach (var channel in subscribers) channel.Writer.TryWrite(snapshot);
    }

    private void SetStatus(string status, string? message) { lock (gate) Publish(status, message); }

    private void OnEvent(JsonElement message)
    {
        lock (gate) if (entities.Apply(message, allowed) || snapshot.Status != "live") Publish("live", null);
    }

    public async Task Toggle(string id, CancellationToken ct)
    {
        HomeAssistantConnection current;
        lock (gate)
        {
            if (active == null || !allowed.Contains(id)) throw new DashboardException(404, "That device is not on the TV dashboard.");
            if (!HomeAssistantSettings.IsToggleable(id)) throw new DashboardException(400, "Only lights and switches can be switched from the TV.");
            if (connection == null || snapshot.Status != "live") throw new DashboardException(503, "Home Assistant is not connected. Try again in a moment.");
            if (entities.StateOf(id) is null or "unavailable" or "unknown") throw new DashboardException(409, "That device is unavailable in Home Assistant.");
            // A shared budget for the whole TV: anyone on the LAN may toggle, but nobody can flood Home Assistant.
            var now = Stopwatch.GetTimestamp();
            while (toggles.Count > 0 && Stopwatch.GetElapsedTime(toggles.Peek(), now) > TimeSpan.FromSeconds(10)) toggles.Dequeue();
            if (toggles.Count >= 20) throw new DashboardException(429, "Too many changes at once. Wait a few seconds.");
            toggles.Enqueue(now);
            current = connection;
        }
        await current.Command("call_service", new() {
            ["domain"] = HomeAssistantSettings.Domain(id), ["service"] = "toggle", ["target"] = new Dictionary<string, object> { ["entity_id"] = id },
        }, TimeSpan.FromSeconds(10), ct);
    }

    private string ReadRevision()
    {
        try { return store.HomeAssistantRevision(); }
        catch (DashboardException) { return "unavailable"; }
    }

    /// <summary>Waits until the saved revision differs from <paramref name="revision"/> or <paramref name="limit"/> passes.</summary>
    private async Task WaitForChange(string revision, TimeSpan? limit, CancellationToken ct)
    {
        var started = Stopwatch.GetTimestamp();
        while (!ct.IsCancellationRequested)
        {
            var remaining = limit is { } max ? max - Stopwatch.GetElapsedTime(started) : options.SettingsPoll;
            if (remaining <= TimeSpan.Zero) return;
            await Task.Delay(remaining < options.SettingsPoll ? remaining : options.SettingsPoll, ct);
            if (ReadRevision() != revision) return;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var invoker = new HttpMessageInvoker(targets.Handler());
        var failures = 0;
        while (!stop.IsCancellationRequested)
        {
            HomeAssistantSettings? settings;
            try { settings = store.HomeAssistantSnapshot(); }
            catch (DashboardException error) { SetStatus("offline", error.Message); await WaitForChange("unavailable", null, stop); continue; }
            if (settings == null)
            {
                lock (gate) { active = null; allowed = []; entities.Clear(); Publish("not-configured", "Connect Home Assistant in the administrator settings."); }
                await WaitForChange("none", null, stop);
                continue;
            }
            lock (gate)
            {
                if (active?.Revision != settings.Revision) { entities.Clear(); failures = 0; }
                active = settings; allowed = settings.EntityIds.ToHashSet();
            }
            string? problem = null;
            try { targets.Require(settings.BaseUrl.AbsoluteUri); } catch (DashboardException error) { problem = error.Message; }
            if (problem == null && string.IsNullOrWhiteSpace(settings.Token)) problem = "Enter a Home Assistant access token in the administrator settings.";
            if (problem != null) { SetStatus("offline", problem); await WaitForChange(settings.Revision, null, stop); continue; }

            SetStatus(Snapshot.Entities.Length > 0 && failures > 0 ? "offline" : "connecting", failures > 0 ? "Reconnecting to Home Assistant…" : "Connecting to Home Assistant…");
            var settingsChanged = false;
            using (var session = CancellationTokenSource.CreateLinkedTokenSource(stop))
            {
                HomeAssistantConnection? opened = null;
                Task? run = null;
                try
                {
                    opened = await HomeAssistantConnection.Open(settings.BaseUrl, settings.Token, invoker, session.Token);
                    run = opened.Run(OnEvent, session.Token);
                    var config = await opened.Command("get_config", null, TimeSpan.FromSeconds(10), session.Token);
                    lock (gate) unit = config.ValueKind == JsonValueKind.Object && config.TryGetProperty("unit_system", out var units) &&
                        units.TryGetProperty("temperature", out var temperature) && temperature.GetString() is { Length: > 0 and <= 8 } symbol ? symbol : null;
                    if (settings.EntityIds.Length > 0)
                        await opened.Command("subscribe_entities", new() { ["entity_ids"] = settings.EntityIds }, TimeSpan.FromSeconds(10), session.Token);
                    lock (gate) { connection = opened; Publish("live", null); }
                    failures = 0;
                    logger.LogInformation("Connected to Home Assistant {Version}.", opened.Version);
                    var monitor = Monitor(opened, settings.Revision, session.Token);
                    var finished = await Task.WhenAny(run, monitor);
                    if (finished == monitor && !monitor.IsFaulted) settingsChanged = true;
                    await finished; // surfaces a closed socket or a failed heartbeat
                }
                catch (Exception error) when (!stop.IsCancellationRequested && error is DashboardException or WebSocketException or HttpRequestException or
                    JsonException or IOException or OperationCanceledException or InvalidOperationException or KeyNotFoundException)
                {
                    failures++;
                    logger.LogWarning("Home Assistant connection ended ({Error}); retrying.", error.GetType().Name);
                    if (error is DashboardException { Status: 400 } rejected) problem = rejected.Message;
                }
                finally
                {
                    session.Cancel();
                    lock (gate) connection = null;
                    if (run != null) try { await run; } catch { /* already reported */ }
                    if (opened != null) await opened.DisposeAsync();
                }
            }
            if (stop.IsCancellationRequested) break;
            if (settingsChanged) continue;
            SetStatus("offline", problem ?? (Snapshot.Entities.Any(e => e.Available) ? "Home Assistant is offline. Showing the last known state." : "Home Assistant is offline. Retrying…"));
            // A rejected token will not fix itself: wait for a new save instead of hammering Home Assistant.
            await WaitForChange(settings.Revision, problem != null ? null : options.Backoff[Math.Clamp(failures - 1, 0, options.Backoff.Length - 1)], stop);
        }
    }

    /// <summary>Completes when the saved settings change; throws when a heartbeat ping goes unanswered.</summary>
    private async Task Monitor(HomeAssistantConnection current, string revision, CancellationToken ct)
    {
        var lastPing = Stopwatch.GetTimestamp();
        while (true)
        {
            await Task.Delay(options.SettingsPoll < options.Heartbeat ? options.SettingsPoll : options.Heartbeat, ct);
            if (ReadRevision() != revision) return;
            if (Stopwatch.GetElapsedTime(lastPing) >= options.Heartbeat)
            {
                await current.Command("ping", null, TimeSpan.FromSeconds(10), ct);
                lastPing = Stopwatch.GetTimestamp();
            }
        }
    }
}

/// <summary>Administrator-side Home Assistant operations: list entities and validate before saving.</summary>
public sealed class HomeAssistantManager(SettingsStore store, HomeAssistantTargets targets)
{
    public static readonly Version Minimum = new(2024, 1);

    private async Task<T> WithConnection<T>(HomeAssistantSettings settings, Func<HomeAssistantConnection, CancellationToken, Task<T>> work, CancellationToken ct)
    {
        if (!targets.HasPinnedAddresses) throw new DashboardException(503, "Configure deployment-approved Home Assistant IP addresses before managing settings.");
        targets.Require(settings.BaseUrl.AbsoluteUri);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        using var invoker = new HttpMessageInvoker(targets.Handler());
        HomeAssistantConnection connection;
        try { connection = await HomeAssistantConnection.Open(settings.BaseUrl, settings.Token, invoker, deadline.Token); }
        catch (Exception error) when (error is WebSocketException or HttpRequestException or IOException or OperationCanceledException && !ct.IsCancellationRequested)
        { throw new DashboardException(502, "Could not reach Home Assistant at the approved address."); }
        await using (connection)
        {
            var run = connection.Run(_ => { }, deadline.Token);
            try { return await work(connection, deadline.Token); }
            finally { deadline.Cancel(); try { await run; } catch { /* closing */ } }
        }
    }

    private static async Task<HomeAssistantEntityOption[]> States(HomeAssistantConnection connection, CancellationToken ct)
    {
        var states = await connection.Command("get_states", null, TimeSpan.FromSeconds(20), ct);
        if (states.ValueKind != JsonValueKind.Array) throw new JsonException("Unexpected Home Assistant states.");
        return states.EnumerateArray()
            .Where(s => s.TryGetProperty("entity_id", out var id) && id.ValueKind == JsonValueKind.String && HomeAssistantSettings.IsSelectable(id.GetString()!))
            .Select(s => {
                var id = s.GetProperty("entity_id").GetString()!;
                var name = s.TryGetProperty("attributes", out var a) && a.ValueKind == JsonValueKind.Object && a.TryGetProperty("friendly_name", out var f) &&
                    f.ValueKind == JsonValueKind.String && f.GetString() is { Length: > 0 } text ? text[..Math.Min(text.Length, 80)] : id;
                var state = s.TryGetProperty("state", out var st) && st.ValueKind == JsonValueKind.String ? st.GetString()! : "unknown";
                return new HomeAssistantEntityOption(id, HomeAssistantSettings.Domain(id), name, state[..Math.Min(state.Length, 64)]);
            })
            .OrderBy(e => Array.IndexOf([.. HomeAssistantSettings.ToggleDomains, .. HomeAssistantSettings.DisplayDomains], e.Domain))
            .ThenBy(e => e.Name, StringComparer.CurrentCultureIgnoreCase).ToArray();
    }

    public Task<HomeAssistantEntityOption[]> Entities(CancellationToken ct)
    {
        var settings = store.HomeAssistantSnapshot() ?? throw new DashboardException(400, "Save the Home Assistant connection and token first.");
        return WithConnection(settings, (connection, token) => States(connection, token), ct);
    }

    public async Task<HomeAssistantView> Save(SaveHomeAssistantRequest request, CancellationToken ct)
    {
        if (request.EntityIds == null || request.EntityIds.Length > SettingsStore.MaxEntities || request.EntityIds.Any(id => !HomeAssistantSettings.IsSelectable(id)))
            throw new DashboardException(400, "Invalid device selection. Lights, switches and climate devices can be selected.");
        var url = targets.Require(request.BaseUrl ?? "");
        if (request.ReplacementToken is { Length: > 4096 } || request.ReplacementToken?.Any(char.IsControl) == true) throw new DashboardException(400, "Invalid replacement token.");
        // A replacement can repair a lost/unreadable old token: never decrypt it first.
        var token = request.ReplacementToken ?? store.HomeAssistantSnapshot()?.Token ?? "";
        if (string.IsNullOrWhiteSpace(token)) throw new DashboardException(400, "Enter the dashboard user's Home Assistant long-lived access token.");
        var candidate = new HomeAssistantSettings(url, token, request.EntityIds.Distinct().ToArray());
        await WithConnection(candidate, async (connection, token) => {
            var config = await connection.Command("get_config", null, TimeSpan.FromSeconds(10), token);
            var version = config.ValueKind == JsonValueKind.Object && config.TryGetProperty("version", out var v) ? v.GetString() : connection.Version;
            var parts = (version ?? "").Split('.');
            if (parts.Length < 2 || !int.TryParse(parts[0], out var year) || !int.TryParse(parts[1], out var month) || new Version(year, month) < Minimum)
                throw new DashboardException(400, $"Home Assistant {Minimum.Major}.{Minimum.Minor} or newer is required.");
            var available = (await States(connection, token)).Select(e => e.Id).ToHashSet();
            if (candidate.EntityIds.Any(id => !available.Contains(id)))
                throw new DashboardException(400, "One or more selected devices are not available to the dashboard's Home Assistant user.");
            return true;
        }, ct);
        return store.CommitHomeAssistant(candidate, request.Revision ?? "");
    }
}

public static class HomeAssistantEndpoints
{
    /// <summary>
    /// The TV listener has no login, and a toggle is its only state-changing endpoint, so it refuses what a
    /// foreign web page could send: a JSON body forces a CORS preflight (no CORS is enabled), cross-site
    /// Origin / Sec-Fetch-Site values are rejected, and the Host must be a LAN name or IP so a
    /// DNS-rebinding domain cannot pose as same-origin.
    /// </summary>
    public static int? RejectForeign(HttpRequest request, IReadOnlySet<string> extraHosts)
    {
        if (!string.Equals(request.ContentType?.Split(';')[0].Trim(), "application/json", StringComparison.OrdinalIgnoreCase)) return 415;
        var site = request.Headers["Sec-Fetch-Site"].ToString();
        if (site.Length > 0 && site is not ("same-origin" or "none")) return 403;
        var origin = request.Headers.Origin.ToString();
        if (origin.Length > 0 && !string.Equals(origin, $"{request.Scheme}://{request.Host}", StringComparison.OrdinalIgnoreCase)) return 403;
        var host = request.Host.Host.TrimEnd('.').ToLowerInvariant();
        var local = System.Net.IPAddress.TryParse(host.Trim('[', ']'), out _) || host == "localhost" || !host.Contains('.') ||
            host.EndsWith(".local") || host.EndsWith(".lan") || host.EndsWith(".home.arpa") || host.EndsWith(".internal") || extraHosts.Contains(host);
        return local ? null : 403;
    }

    public static void Map(WebApplication app, IReadOnlySet<string> extraHosts)
    {
        app.MapGet("/api/home", (HomeAssistantHub hub) => Results.Ok(hub.Snapshot));
        app.MapGet("/api/home/events", Events);
        app.MapPost("/api/home/entities/{id}/toggle", async (string id, HomeAssistantHub hub, HttpContext context) => {
            if (RejectForeign(context.Request, extraHosts) is { } status) return Results.StatusCode(status);
            if (!HomeAssistantSettings.IsEntityId(id)) return Results.NotFound(new { message = "That device is not on the TV dashboard." });
            await hub.Toggle(id, context.RequestAborted);
            return Results.NoContent();
        });
    }

    /// <summary>Server-Sent Events: a full snapshot on connect and after every change, a comment every 25 s to keep it open.</summary>
    private static async Task Events(HttpContext context, HomeAssistantHub hub)
    {
        using var subscription = hub.Subscribe();
        var response = context.Response;
        response.ContentType = "text/event-stream";
        response.Headers.CacheControl = "no-store";
        var ct = context.RequestAborted;
        await response.WriteAsync("retry: 3000\n\n", ct);
        while (!ct.IsCancellationRequested)
        {
            using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
            wait.CancelAfter(TimeSpan.FromSeconds(25));
            bool ready;
            try { ready = await subscription.Reader.WaitToReadAsync(wait.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { await response.WriteAsync(": keepalive\n\n", ct); await response.Body.FlushAsync(ct); continue; }
            if (!ready) return;
            while (subscription.Reader.TryRead(out var snapshot))
                await response.WriteAsync($"event: snapshot\ndata: {JsonSerializer.Serialize(snapshot, JsonSerializerOptions.Web)}\n\n", ct);
            await response.Body.FlushAsync(ct);
        }
    }
}
