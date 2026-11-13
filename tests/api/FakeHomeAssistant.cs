using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace SmartTv.Testing;

/// <summary>
/// A synthetic Home Assistant WebSocket API for tests: auth, get_config, get_states, subscribe_entities
/// (compressed a/c events), call_service toggle and ping. Also used by the browser test host, which
/// changes states "from the wall switch" through POST /test/state/{entity}/{state}.
/// </summary>
public sealed class FakeHomeAssistant : IAsyncDisposable
{
    public sealed record Device(string State, Dictionary<string, object?> Attributes);
    private sealed class Client(WebSocket socket)
    {
        public WebSocket Socket { get; } = socket;
        public SemaphoreSlim Lock { get; } = new(1, 1);
        public int? Subscription;
        public HashSet<string> Entities = [];
    }

    public string Token { get; set; } = "synthetic-ha-token";
    public string Version { get; set; } = "2026.11.0";
    public bool DenyCalls { get; set; }
    public ConcurrentDictionary<string, Device> States { get; } = new();
    public ConcurrentQueue<string> Calls { get; } = new();
    public ConcurrentQueue<string[]> Subscriptions { get; } = new();
    public int Connections => connections;
    public Uri ApiBase { get; private set; } = null!;
    private readonly ConcurrentDictionary<Client, byte> clients = new();
    private WebApplication? app;
    private int connections;

    public static FakeHomeAssistant WithSampleHome()
    {
        var fake = new FakeHomeAssistant();
        fake.States["light.kitchen"] = new("on", new() { ["friendly_name"] = "Kitchen", ["brightness"] = 153 });
        fake.States["light.living_room"] = new("off", new() { ["friendly_name"] = "Living room" });
        fake.States["light.porch"] = new("unavailable", new() { ["friendly_name"] = "Porch" });
        fake.States["switch.fan"] = new("off", new() { ["friendly_name"] = "Ceiling fan" });
        fake.States["climate.hallway"] = new("heat", new() {
            ["friendly_name"] = "Hallway thermostat", ["current_temperature"] = 68.5, ["temperature"] = 70, ["hvac_action"] = "heating" });
        fake.States["sensor.outdoor"] = new("54", new() { ["friendly_name"] = "Outdoor temperature" });
        return fake;
    }

    public async Task Start(int port = 0)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
        app = builder.Build();
        app.UseWebSockets();
        app.Map("/api/websocket", async context => {
            if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            Interlocked.Increment(ref connections);
            await Serve(new Client(socket), context.RequestAborted);
        });
        app.MapPost("/test/state/{id}/{state}", async (string id, string state) => { await SetState(id, state); return Results.NoContent(); });
        await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        ApiBase = new Uri(address.TrimEnd('/') + "/api/");
    }

    private static object Compressed(Device device) => new { s = device.State, a = device.Attributes, c = "ctx", lc = 1.0 };

    private static async Task Send(Client client, object message)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        await client.Lock.WaitAsync();
        try { if (client.Socket.State == WebSocketState.Open) await client.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, default); }
        catch (WebSocketException) { }
        finally { client.Lock.Release(); }
    }

    private static async Task<JsonDocument?> Receive(WebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024]; using var stream = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            stream.Write(buffer, 0, result.Count);
            if (result.EndOfMessage) return JsonDocument.Parse(stream.ToArray());
        }
    }

    private async Task Serve(Client client, CancellationToken ct)
    {
        try
        {
            await Send(client, new { type = "auth_required", ha_version = Version });
            using (var auth = await Receive(client.Socket, ct))
            {
                if (auth?.RootElement.GetProperty("access_token").GetString() != Token)
                {
                    await Send(client, new { type = "auth_invalid", message = "Invalid access token or password" });
                    return;
                }
            }
            await Send(client, new { type = "auth_ok", ha_version = Version });
            clients[client] = 0;
            while (true)
            {
                using var message = await Receive(client.Socket, ct);
                if (message == null) return;
                var root = message.RootElement;
                var id = root.GetProperty("id").GetInt32();
                switch (root.GetProperty("type").GetString())
                {
                    case "ping": await Send(client, new { id, type = "pong" }); break;
                    case "get_config":
                        await Send(client, new { id, type = "result", success = true, result = new { version = Version, unit_system = new { temperature = "°F" } } });
                        break;
                    case "get_states":
                        await Send(client, new { id, type = "result", success = true, result = States.Select(s => new { entity_id = s.Key, state = s.Value.State, attributes = s.Value.Attributes }) });
                        break;
                    case "subscribe_entities":
                        var ids = root.GetProperty("entity_ids").EnumerateArray().Select(e => e.GetString()!).ToArray();
                        Subscriptions.Enqueue(ids);
                        client.Subscription = id; client.Entities = ids.ToHashSet();
                        await Send(client, new { id, type = "result", success = true, result = (object?)null });
                        await Send(client, new { id, type = "event", @event = new { a = ids.Where(States.ContainsKey).ToDictionary(e => e, e => Compressed(States[e])) } });
                        break;
                    case "call_service":
                        var target = root.GetProperty("target").GetProperty("entity_id").GetString()!;
                        Calls.Enqueue($"{root.GetProperty("domain").GetString()}.{root.GetProperty("service").GetString()} {target}");
                        if (DenyCalls) { await Send(client, new { id, type = "result", success = false, error = new { code = "unauthorized", message = "Unauthorized" } }); break; }
                        await Send(client, new { id, type = "result", success = true, result = new { context = new { id = "ctx" } } });
                        if (States.TryGetValue(target, out var device)) await SetState(target, device.State == "on" ? "off" : "on");
                        break;
                    default:
                        await Send(client, new { id, type = "result", success = false, error = new { code = "unknown_command", message = "Unknown command." } });
                        break;
                }
            }
        }
        catch (Exception error) when (error is WebSocketException or OperationCanceledException) { }
        finally { clients.TryRemove(client, out _); }
    }

    /// <summary>Changes a state as a physical switch would, pushing a compressed change to subscribers.</summary>
    public async Task SetState(string id, string state, Dictionary<string, object?>? attributes = null)
    {
        var previous = States.GetValueOrDefault(id) ?? new Device(state, []);
        var next = new Device(state, attributes ?? previous.Attributes);
        States[id] = next;
        foreach (var client in clients.Keys.Where(c => c.Subscription != null && c.Entities.Contains(id)))
            await Send(client, new { id = client.Subscription, type = "event", @event = new { c = new Dictionary<string, object> {
                [id] = new Dictionary<string, object> { ["+"] = new { s = state, a = next.Attributes, lc = 2.0 } } } } });
    }

    /// <summary>Drops every open socket, as a Home Assistant restart would.</summary>
    public void DropConnections() { foreach (var client in clients.Keys) client.Socket.Abort(); }

    public async ValueTask DisposeAsync()
    {
        DropConnections();
        if (app != null) { await app.StopAsync(); await app.DisposeAsync(); }
    }
}
