using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SmartTv;
using SmartTv.Testing;
using Xunit;

// Boolean assertions avoid printing token material on failure.
#pragma warning disable xUnit2009

public class HomeAssistantEntitiesTests
{
    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement;
    private static readonly HashSet<string> Allowed = ["light.kitchen", "climate.hallway", "switch.fan"];

    [Fact]
    public void AppliesAddChangeAndRemoveForAllowlistedEntitiesOnly()
    {
        var entities = new HomeAssistantEntities();
        Assert.True(entities.Apply(Json("""{"a":{"light.kitchen":{"s":"on","a":{"friendly_name":"Kitchen","brightness":255,"secret":"x"}},"lock.front":{"s":"locked","a":{}}}}"""), Allowed));
        Assert.Null(entities.StateOf("lock.front"));
        Assert.Equal(new HomeEntity("light.kitchen", "light", "Kitchen", "on", true, true, true, 100), entities.Describe("light.kitchen", "°F"));

        Assert.True(entities.Apply(Json("""{"c":{"light.kitchen":{"+":{"s":"on","a":{"brightness":128},"lc":2},"-":{"a":["friendly_name"]}}}}"""), Allowed));
        Assert.Equal(new HomeEntity("light.kitchen", "light", "light.kitchen", "on", true, true, true, 50), entities.Describe("light.kitchen", null));
        Assert.True(entities.Apply(Json("""{"c":{"light.kitchen":{"+":{"s":"off"}}}}"""), Allowed));
        Assert.Equal(new HomeEntity("light.kitchen", "light", "light.kitchen", "off", true, false, true), entities.Describe("light.kitchen", null));
        // A change for something never added (or not allowed) is ignored.
        Assert.False(entities.Apply(Json("""{"c":{"lock.front":{"+":{"s":"unlocked"}}}}"""), Allowed));
        Assert.True(entities.Apply(Json("""{"r":["light.kitchen"]}"""), Allowed));
        Assert.Equal(new HomeEntity("light.kitchen", "light", "light.kitchen", "unavailable", false, false, true), entities.Describe("light.kitchen", null));
        Assert.False(entities.Apply(Json("""[1,2]"""), Allowed));
    }

    [Fact]
    public void DescribesClimateReadOnlyAndCapsUntrustedText()
    {
        var entities = new HomeAssistantEntities();
        var longName = new string('n', 200);
        entities.Apply(Json("""{"a":{"climate.hallway":{"s":"heat","a":{"friendly_name":"NAME","current_temperature":68.5,"temperature":70,"hvac_action":"heating","target_temp_low":"bad"}},"switch.fan":{"s":"unavailable","a":{}}}}""".Replace("NAME", longName)), Allowed);
        var climate = entities.Describe("climate.hallway", "°F");
        Assert.Equal(80, climate.Name.Length);
        Assert.False(climate.Toggleable); Assert.True(climate.On);
        Assert.Equal((68.5, 70.0, (double?)null, "heating", "°F"), (climate.CurrentTemperature!.Value, climate.TargetTemperature!.Value, climate.TargetLow, climate.HvacAction, climate.Unit));
        var fan = entities.Describe("switch.fan", null);
        Assert.False(fan.Available); Assert.True(fan.Toggleable);
    }

    [Theory]
    [InlineData("light.kitchen", true, true)]
    [InlineData("switch.fan", true, true)]
    [InlineData("climate.hallway", true, false)]
    [InlineData("sensor.outdoor", false, false)]
    [InlineData("lock.front_door", false, false)]
    [InlineData("light.Kitchen", false, false)]
    [InlineData("light.kitchen/../x", false, false)]
    [InlineData("light", false, false)]
    public void OnlyLightsAndSwitchesToggleAndClimateDisplays(string id, bool selectable, bool toggleable)
    {
        Assert.Equal(selectable, HomeAssistantSettings.IsSelectable(id));
        Assert.Equal(toggleable, HomeAssistantSettings.IsToggleable(id));
    }

    [Theory]
    [InlineData("application/json", null, null, "10.0.0.11", null)]
    [InlineData("application/json; charset=utf-8", "same-origin", "http://10.0.0.11:8080", "10.0.0.11", null)]
    [InlineData("application/json", null, null, "lazyboy", null)]
    [InlineData("application/json", null, null, "tv.lan", null)]
    [InlineData("application/json", null, null, "tv.example.net", 403)] // DNS rebinding domain
    [InlineData("application/json", null, null, "smart.example.com", null)] // configured extra host
    [InlineData("text/plain", null, null, "10.0.0.11", 415)]
    [InlineData(null, null, null, "10.0.0.11", 415)]
    [InlineData("application/json", "cross-site", null, "10.0.0.11", 403)]
    [InlineData("application/json", "same-site", null, "10.0.0.11", 403)]
    [InlineData("application/json", null, "http://evil.test", "10.0.0.11", 403)]
    public void ToggleRefusesRequestsAForeignPageCouldSend(string? contentType, string? site, string? origin, string host, int? expected)
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "http"; context.Request.Host = new HostString(host, 8080);
        context.Request.ContentType = contentType;
        if (site != null) context.Request.Headers["Sec-Fetch-Site"] = site;
        if (origin != null) context.Request.Headers.Origin = origin;
        Assert.Equal(expected, HomeAssistantEndpoints.RejectForeign(context.Request, new HashSet<string> { "smart.example.com" }));
    }
}

public class HomeAssistantStoreTests(SettingsMaterial material) : IClassFixture<SettingsMaterial>
{
    private static HomeAssistantSettings Sample(string token = "synthetic-ha-token") =>
        new(new Uri("http://127.0.0.1:8123/api/"), token, ["light.kitchen", "climate.hallway"]);

    [Fact]
    public void TokenIsEncryptedMaskedAndVisibleToAReadOnlyReaderWithoutRestart()
    {
        var path = material.State(); var writer = material.Store(path); var reader = material.Store(path, writable: false);
        Assert.Equal(new HomeAssistantView("none", false, "", [], false, null), reader.HomeAssistantView());
        Assert.Null(reader.HomeAssistantSnapshot());
        var saved = writer.CommitHomeAssistant(Sample(), "none");
        Assert.True(saved.TokenConfigured);
        Assert.True(saved.MaskedToken == SettingsStore.MaskKey("synthetic-ha-token"));
        Assert.True(reader.HomeAssistantSnapshot()!.Token == "synthetic-ha-token");
        Assert.Equal(["light.kitchen", "climate.hallway"], reader.HomeAssistantSnapshot()!.EntityIds);
        Assert.Equal(saved.Revision, reader.HomeAssistantRevision());
        Assert.False(File.ReadAllText(Path.Combine(path, "home-assistant.json")).Contains("synthetic-ha-token"));
        Assert.False(JsonSerializer.Serialize(reader.HomeAssistantView()).Contains("synthetic-ha-token"));
        Assert.Equal(403, Assert.Throws<DashboardException>(() => reader.CommitHomeAssistant(Sample(), saved.Revision)).Status);
        Assert.Equal(409, Assert.Throws<DashboardException>(() => writer.CommitHomeAssistant(Sample(), "none")).Status);
        // Independent of the Immich document: neither save disturbs the other.
        Assert.Equal("environment", writer.View().Source);
    }

    [Fact]
    public void ImmichCiphertextCannotBeReadAsTheHomeAssistantToken()
    {
        var path = material.State(); var store = material.Store(path);
        store.Commit(store.Snapshot(), "environment");
        var view = store.CommitHomeAssistant(Sample(), "none");
        var immich = JsonSerializer.Deserialize<StoredSettings>(File.ReadAllText(Path.Combine(path, "settings.json")))!;
        var assistant = JsonSerializer.Deserialize<StoredHomeAssistant>(File.ReadAllText(Path.Combine(path, "home-assistant.json")))!;
        PrivateFiles.Json(Path.Combine(path, "home-assistant.json"), assistant with { ProtectionGeneration = immich.ProtectionGeneration, ProtectedToken = immich.ProtectedKey });
        Assert.Equal(503, Assert.Throws<DashboardException>(() => store.HomeAssistantSnapshot()).Status);
        Assert.Null(store.HomeAssistantView().MaskedToken);
        Assert.NotEqual("none", view.Revision);
    }

    [Fact]
    public void CorruptDocumentFailsClosed()
    {
        var path = material.State(); var store = material.Store(path);
        store.CommitHomeAssistant(Sample(), "none");
        var stored = JsonSerializer.Deserialize<StoredHomeAssistant>(File.ReadAllText(Path.Combine(path, "home-assistant.json")))!;
        PrivateFiles.Json(Path.Combine(path, "home-assistant.json"), stored with { EntityIds = ["light.kitchen", "../etc"] });
        Assert.Equal(503, Assert.Throws<DashboardException>(() => store.HomeAssistantSnapshot()).Status);
        Assert.Equal(503, Assert.Throws<DashboardException>(() => store.HomeAssistantRevision()).Status);
    }

    [Fact]
    public void WrappingRecoveryClearsTheTokenButKeepsTheSelection()
    {
        var path = material.State(); material.Store(path).CommitHomeAssistant(Sample(), "none");
        var newMaterial = Path.Combine(material.Root, Guid.NewGuid().ToString("N")); Provisioning.Material(newMaterial);
        var recovery = material.Store(path, material: newMaterial);
        Assert.Equal(503, Assert.Throws<DashboardException>(() => recovery.HomeAssistantSnapshot()).Status);
        recovery.RecoverWrappingKey(); // works with only Home Assistant settings persisted
        Assert.False(recovery.HomeAssistantView().TokenConfigured);
        Assert.Equal(["light.kitchen", "climate.hallway"], recovery.HomeAssistantView().EntityIds);
        Assert.Empty(recovery.HomeAssistantSnapshot()!.Token);
        recovery.CommitHomeAssistant(Sample("synthetic-restored-token"), recovery.HomeAssistantView().Revision);
        Assert.True(material.Store(path, material: newMaterial, writable: false).HomeAssistantSnapshot()!.Token == "synthetic-restored-token");
    }
}

public class HomeAssistantLiveTests(SettingsMaterial material) : IClassFixture<SettingsMaterial>
{
    private static readonly HomeAssistantOptions Fast = new(TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(300),
        [TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(200)]);

    private static async Task Until(Func<bool> condition, string what, int milliseconds = 10_000)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException($"Timed out waiting for {what}.");
            await Task.Delay(25);
        }
    }

    private static HomeAssistantTargets Targets(FakeHomeAssistant fake, string address = "127.0.0.1") => new([fake.ApiBase.AbsoluteUri], [address]);

    [Fact]
    public async Task SaveValidatesTokenVersionAndEntitiesBeforePersisting()
    {
        await using var fake = FakeHomeAssistant.WithSampleHome(); await fake.Start();
        var store = material.Store(material.State());
        var manager = new HomeAssistantManager(store, Targets(fake));
        var url = fake.ApiBase.AbsoluteUri;

        Assert.Equal(400, (await Assert.ThrowsAsync<DashboardException>(() => manager.Entities(default))).Status);
        Assert.Equal(400, (await Assert.ThrowsAsync<DashboardException>(() => manager.Save(new("none", url, null, []), default))).Status);
        Assert.Equal(400, (await Assert.ThrowsAsync<DashboardException>(() => manager.Save(new("none", url, "synthetic-wrong-token", []), default))).Status);
        Assert.Equal(400, (await Assert.ThrowsAsync<DashboardException>(() => manager.Save(new("none", "http://127.0.0.1:1/api/", "synthetic-ha-token", []), default))).Status);
        Assert.Equal(400, (await Assert.ThrowsAsync<DashboardException>(() => manager.Save(new("none", url, "synthetic-ha-token", ["sensor.outdoor"]), default))).Status);
        Assert.Equal(400, (await Assert.ThrowsAsync<DashboardException>(() => manager.Save(new("none", url, "synthetic-ha-token", ["light.missing"]), default))).Status);
        fake.Version = "2023.12.4";
        Assert.Equal(400, (await Assert.ThrowsAsync<DashboardException>(() => manager.Save(new("none", url, "synthetic-ha-token", []), default))).Status);
        fake.Version = "2026.11.0";
        Assert.Equal("none", store.HomeAssistantView().Revision); // every failure left nothing behind

        var saved = await manager.Save(new("none", url, "synthetic-ha-token", []), default);
        Assert.True(saved.TokenConfigured);
        var options = await manager.Entities(default);
        Assert.DoesNotContain(options, o => o.Id == "sensor.outdoor");
        Assert.Equal("Ceiling fan", options.Single(o => o.Id == "switch.fan").Name);
        // Lights first, then switches, then climate; names sorted inside each group.
        Assert.Equal(["light.kitchen", "light.living_room", "light.porch", "switch.fan", "climate.hallway"], options.Select(o => o.Id));

        // Blank replacement keeps the saved token; a rejected replacement keeps the old one.
        saved = await manager.Save(new(saved.Revision, url, null, ["light.kitchen", "climate.hallway"]), default);
        Assert.Equal(["light.kitchen", "climate.hallway"], saved.EntityIds);
        Assert.Equal(400, (await Assert.ThrowsAsync<DashboardException>(() => manager.Save(new(saved.Revision, url, "synthetic-wrong-token", []), default))).Status);
        Assert.True(store.HomeAssistantSnapshot()!.Token == "synthetic-ha-token");
    }

    [Fact]
    public async Task PinnedAddressesApplyToTheWebSocket()
    {
        await using var fake = FakeHomeAssistant.WithSampleHome(); await fake.Start();
        var manager = new HomeAssistantManager(material.Store(material.State()), Targets(fake, "192.0.2.1"));
        Assert.Equal(502, (await Assert.ThrowsAsync<DashboardException>(() => manager.Save(new("none", fake.ApiBase.AbsoluteUri, "synthetic-ha-token", []), default))).Status);
        Assert.Equal(0, fake.Connections);
        var unpinned = new HomeAssistantManager(material.Store(material.State()), new HomeAssistantTargets([fake.ApiBase.AbsoluteUri], []));
        Assert.Equal(503, (await Assert.ThrowsAsync<DashboardException>(() => unpinned.Save(new("none", fake.ApiBase.AbsoluteUri, "synthetic-ha-token", []), default))).Status);
    }

    [Fact]
    public async Task HubStreamsLiveStateTogglesAllowlistedDevicesAndRecovers()
    {
        await using var fake = FakeHomeAssistant.WithSampleHome(); await fake.Start();
        var store = material.Store(material.State());
        var hub = new HomeAssistantHub(store, Targets(fake), NullLogger<HomeAssistantHub>.Instance, Fast);
        await hub.StartAsync(default);
        try
        {
            await Until(() => hub.Snapshot.Status == "not-configured", "not-configured");
            var view = store.CommitHomeAssistant(new(fake.ApiBase, "synthetic-ha-token", ["light.kitchen", "switch.fan", "light.porch", "climate.hallway"]), "none");
            await Until(() => hub.Snapshot.Status == "live" && hub.Snapshot.Entities.Any(e => e.Available), "first live snapshot");
            Assert.Equal(["light.kitchen", "switch.fan", "light.porch", "climate.hallway"], fake.Subscriptions.Last());
            var kitchen = hub.Snapshot.Entities[0];
            Assert.Equal(("Kitchen", true, 60), (kitchen.Name, kitchen.On, kitchen.Brightness!.Value));
            Assert.Equal("°F", hub.Snapshot.Entities[3].Unit);
            Assert.False(JsonSerializer.Serialize(hub.Snapshot).Contains("synthetic-ha-token"));

            using var subscription = hub.Subscribe();
            Assert.True(subscription.Reader.TryRead(out var first) && first.Status == "live");
            await fake.SetState("light.kitchen", "off");
            await Until(() => !hub.Snapshot.Entities[0].On, "external change");
            Assert.True(subscription.Reader.TryRead(out var pushed) && !pushed.Entities[0].On);

            await hub.Toggle("switch.fan", default);
            Assert.Equal("switch.toggle switch.fan", fake.Calls.Last());
            await Until(() => hub.Snapshot.Entities[1].On, "toggled fan");
            Assert.Equal(404, (await Assert.ThrowsAsync<DashboardException>(() => hub.Toggle("light.living_room", default))).Status);
            Assert.Equal(400, (await Assert.ThrowsAsync<DashboardException>(() => hub.Toggle("climate.hallway", default))).Status);
            Assert.Equal(409, (await Assert.ThrowsAsync<DashboardException>(() => hub.Toggle("light.porch", default))).Status);
            fake.DenyCalls = true;
            Assert.Equal(403, (await Assert.ThrowsAsync<DashboardException>(() => hub.Toggle("light.kitchen", default))).Status);
            fake.DenyCalls = false;

            // Home Assistant restarts: last known state stays, marked offline, then live again.
            var before = fake.Connections;
            fake.DropConnections();
            await Until(() => fake.Connections > before && hub.Snapshot.Status == "live", "reconnect");
            Assert.True(hub.Snapshot.Entities[1].On);

            // A save on the administrator side switches the subscription without a restart.
            store.CommitHomeAssistant(new(fake.ApiBase, "synthetic-ha-token", ["light.living_room"]), view.Revision);
            await Until(() => hub.Snapshot.Entities.Length == 1 && hub.Snapshot.Entities[0].Id == "light.living_room" && hub.Snapshot.Status == "live", "new selection");
            await hub.Toggle("light.living_room", default);
            await Until(() => hub.Snapshot.Entities[0].On, "toggled living room");

            // A revoked token stops retrying and says so.
            fake.Token = "synthetic-rotated-token";
            fake.DropConnections();
            await Until(() => hub.Snapshot.Status == "offline" && hub.Snapshot.Message!.Contains("rejected the access token"), "rejected token");
            var attempts = fake.Connections;
            await Task.Delay(600);
            Assert.Equal(attempts, fake.Connections);
        }
        finally { await hub.StopAsync(default); }
    }

    [Fact]
    public async Task PublicListenerStreamsEventsAndTogglesWithoutExposingTheToken()
    {
        await using var fake = FakeHomeAssistant.WithSampleHome(); await fake.Start();
        var state = material.State();
        material.Store(state).CommitHomeAssistant(new(fake.ApiBase, "synthetic-ha-token", ["light.kitchen", "climate.hallway"]), "none");
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
        await using var host = DashboardHost.Build(["--urls", $"http://127.0.0.1:{port}"], builder => {
            builder.Logging.ClearProviders();
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?> {
                ["Settings:Directory"] = state, ["Settings:WrappingCertificate"] = Path.Combine(material.Material, "wrapping.crt"),
                ["Settings:WrappingKey"] = Path.Combine(material.Material, "wrapping.key"),
                ["Immich:BaseUrl"] = "http://immich.test:2283/api/", ["Immich:Targets"] = "http://immich.test:2283/api/", ["Immich:AllowedAddresses"] = "127.0.0.1",
                ["HomeAssistant:Targets"] = fake.ApiBase.AbsoluteUri, ["HomeAssistant:AllowedAddresses"] = "127.0.0.1",
            });
            builder.Services.AddSingleton(Fast);
        });
        await host.StartAsync();
        try
        {
            using var client = new HttpClient(new HttpClientHandler { UseProxy = false }) { BaseAddress = new Uri($"http://127.0.0.1:{port}") };
            using var stream = await client.GetStreamAsync("/api/home/events");
            using var reader = new StreamReader(stream);
            async Task<JsonDocument> NextSnapshot()
            {
                while (true)
                {
                    var line = await reader.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
                    Assert.False(line!.Contains("synthetic-ha-token"));
                    if (line.StartsWith("data: ")) return JsonDocument.Parse(line[6..]);
                }
            }
            JsonDocument snapshot;
            do snapshot = await NextSnapshot(); while (snapshot.RootElement.GetProperty("status").GetString() != "live" ||
                !snapshot.RootElement.GetProperty("entities")[0].GetProperty("available").GetBoolean());
            Assert.True(snapshot.RootElement.GetProperty("entities")[0].GetProperty("on").GetBoolean());

            using (var plain = new StringContent("{}"))
                Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await client.PostAsync("/api/home/entities/light.kitchen/toggle", plain)).StatusCode);
            using (var foreign = new HttpRequestMessage(HttpMethod.Post, "/api/home/entities/light.kitchen/toggle") { Content = JsonContent.Create(new { }) })
            {
                foreign.Headers.Add("Origin", "http://evil.test");
                Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(foreign)).StatusCode);
            }
            Assert.Empty(fake.Calls);
            var climate = await client.PostAsJsonAsync("/api/home/entities/climate.hallway/toggle", new { });
            Assert.Equal(HttpStatusCode.BadRequest, climate.StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/api/home/entities/lock.front/toggle", new { })).StatusCode);
            Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsJsonAsync("/api/home/entities/light.kitchen/toggle", new { })).StatusCode);
            Assert.Equal("light.toggle light.kitchen", Assert.Single(fake.Calls));
            do snapshot = await NextSnapshot(); while (snapshot.RootElement.GetProperty("entities")[0].GetProperty("on").GetBoolean());

            var json = await client.GetStringAsync("/api/home");
            Assert.False(json.Contains("synthetic-ha-token"));
            Assert.Contains("\"hvacAction\":\"heating\"", json);
            Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/admin/home-assistant")).StatusCode);
        }
        finally { await host.StopAsync(); }
    }
}
