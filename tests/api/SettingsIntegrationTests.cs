using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using SmartTv;
using Xunit;

// Boolean assertions avoid printing response bodies or key material on failure.
#pragma warning disable xUnit2009

public class SettingsIntegrationTests(SettingsMaterial material) : IClassFixture<SettingsMaterial>
{
    private static int Port()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port;
    }
    private WebApplication Host(string path, bool admin, int port) => DashboardHost.Build(
        ["--urls", admin ? "http://0.0.0.0:9999" : $"http://127.0.0.1:{port}"], builder => {
            builder.Logging.ClearProviders();
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?> {
                ["Administrator:Enabled"] = admin.ToString(), ["Administrator:Port"] = port.ToString(),
                ["Administrator:Certificate"] = Path.Combine(material.Material, "localhost.crt"), ["Administrator:PrivateKey"] = Path.Combine(material.Material, "localhost.key"),
                ["Settings:Directory"] = path, ["Settings:WrappingCertificate"] = Path.Combine(material.Material, "wrapping.crt"), ["Settings:WrappingKey"] = Path.Combine(material.Material, "wrapping.key"),
                ["Immich:BaseUrl"] = "http://immich.test:2283/api/", ["Immich:Targets"] = "http://immich.test:2283/api/", ["Immich:AllowedAddresses"] = "127.0.0.1",
                ["Immich:ApiKey"] = "synthetic-read-key", ["Immich:AlbumIds"] = SettingsTests.Owned.ToString()
            });
            builder.Services.AddSingleton<IHttpClientFactory>(new SettingsTests.ImmichStub());
        });
    private HttpClient Client(int port, CookieContainer? cookies = null)
    {
        using var expected = X509Certificate2.CreateFromPem(File.ReadAllText(Path.Combine(material.Material, "localhost.crt")));
        var thumbprint = expected.GetCertHashString(HashAlgorithmName.SHA256);
        return new(new HttpClientHandler {
            UseProxy = false, CookieContainer = cookies ?? new CookieContainer(), AllowAutoRedirect = false,
            ServerCertificateCustomValidationCallback = (_, cert, _, _) => cert != null && cert.GetCertHashString(HashAlgorithmName.SHA256) == thumbprint
        }) { BaseAddress = new Uri($"https://localhost:{port}") };
    }
    private static async Task<string> Csrf(HttpClient client)
    {
        using var json = JsonDocument.Parse(await client.GetStringAsync("/api/admin/csrf"));
        return json.RootElement.GetProperty("token").GetString()!;
    }
    private static async Task<HttpResponseMessage> Mutation(HttpClient client, HttpMethod method, string path, object body, string? token)
    {
        using var request = new HttpRequestMessage(method, path) { Content = JsonContent.Create(body) };
        request.Headers.Add("Origin", client.BaseAddress!.GetLeftPart(UriPartial.Authority));
        if (token != null) request.Headers.Add("X-CSRF", token);
        return await client.SendAsync(request);
    }
    [Fact]
    public async Task RestartRetainsSelectedAlbumsAndKeyButExpiresAdministratorSessions()
    {
        var state = material.State(); new AdministratorIdentity(state, TimeProvider.System).SetPassword("synthetic-passphrase", false);
        var port = Port(); var cookies = new CookieContainer();
        await using (var host = Host(state, true, port))
        {
            await host.StartAsync();
            // Broad ASPNETCORE_URLS cannot expand the admin listener.
            Assert.Equal($"https://127.0.0.1:{port}", Assert.Single(host.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses));
            using var client = Client(port, cookies);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/admin/settings")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/remote")).StatusCode);
            var token = await Csrf(client);
            Assert.Equal(HttpStatusCode.OK, (await Mutation(client, HttpMethod.Post, "/api/admin/login", new { password = "synthetic-passphrase" }, token)).StatusCode);
            token = await Csrf(client);
            Assert.Equal(HttpStatusCode.BadRequest, (await Mutation(client, HttpMethod.Put, "/api/admin/settings", new { }, null)).StatusCode);
            var saved = await Mutation(client, HttpMethod.Put, "/api/admin/settings", new SaveSettingsRequest("environment", "http://immich.test:2283/api/", "synthetic-new-key", [SettingsTests.Shared]), token);
            Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
            var savedBody = await saved.Content.ReadAsStringAsync();
            Assert.False(savedBody.Contains("synthetic-new-key"));
            using var savedJson = JsonDocument.Parse(savedBody);
            Assert.True(savedJson.RootElement.GetProperty("maskedKey").GetString() == SettingsStore.MaskKey("synthetic-new-key"));
            await host.StopAsync();
        }
        await using (var restarted = Host(state, true, port))
        {
            await restarted.StartAsync(); using var client = Client(port, cookies);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/admin/settings")).StatusCode);
            var token = await Csrf(client);
            Assert.Equal(HttpStatusCode.OK, (await Mutation(client, HttpMethod.Post, "/api/admin/login", new { password = "synthetic-passphrase" }, token)).StatusCode);
            using var settings = JsonDocument.Parse(await client.GetStringAsync("/api/admin/settings"));
            Assert.True(settings.RootElement.GetProperty("settings").GetProperty("maskedKey").GetString() == SettingsStore.MaskKey("synthetic-new-key"));
            Assert.Equal("persisted", settings.RootElement.GetProperty("settings").GetProperty("source").GetString());
            Assert.Equal(SettingsTests.Shared, settings.RootElement.GetProperty("settings").GetProperty("albumIds")[0].GetGuid());
            await restarted.StopAsync();
        }
        var publicPort = Port(); await using var tv = Host(state, false, publicPort); await tv.StartAsync();
        using var publicClient = new HttpClient(new HttpClientHandler { UseProxy = false }) { BaseAddress = new Uri($"http://127.0.0.1:{publicPort}") };
        foreach (var endpoint in new[] { "/api/albums", "/api/remote", "/api/health", "/api/admin/settings" })
        {
            var body = await (await publicClient.GetAsync(endpoint)).Content.ReadAsStringAsync();
            Assert.False(body.Contains("maskedKey"));
            Assert.False(body.Contains(SettingsStore.MaskKey("synthetic-new-key")!));
            Assert.False(body.Contains("synthetic-new-key"));
        }
        var albums = await publicClient.GetFromJsonAsync<Album[]>("/api/albums"); Assert.Equal(SettingsTests.Shared, Assert.Single(albums!).Id);
        publicClient.DefaultRequestHeaders.Add("Cookie", cookies.GetCookieHeader(new Uri($"https://localhost:{port}")));
        publicClient.DefaultRequestHeaders.Add("X-Forwarded-Proto", "https"); publicClient.DefaultRequestHeaders.Add("X-Forwarded-For", "127.0.0.1");
        Assert.Equal(HttpStatusCode.NotFound, (await publicClient.GetAsync("/api/admin/settings")).StatusCode);
        await tv.StopAsync();
    }
    [Fact]
    public async Task SettingsEndpointRequiresAuthenticatedAdministratorRole()
    {
        await using var host = Host(material.State(), true, Port());
        var authorization = host.Services.GetRequiredService<Microsoft.AspNetCore.Authorization.IAuthorizationService>();
        var endpoint = ((Microsoft.AspNetCore.Routing.IEndpointRouteBuilder)host).DataSources
            .SelectMany(source => source.Endpoints)
            .OfType<Microsoft.AspNetCore.Routing.RouteEndpoint>()
            .First(endpoint => endpoint.RoutePattern.RawText == "/api/admin/settings");
        Assert.Contains(endpoint.Metadata.GetOrderedMetadata<Microsoft.AspNetCore.Authorization.IAuthorizeData>(), data => data.Policy == "Administrator");
        foreach (var role in new[] { "Phone", "Administrator" })
        {
            var user = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity(
                new[] { new System.Security.Claims.Claim(System.Security.Claims.ClaimTypes.Role, role) }, "test"));
            Assert.Equal(role == "Administrator", (await authorization.AuthorizeAsync(user, null, "Administrator")).Succeeded);
        }
        Assert.False((await authorization.AuthorizeAsync(new System.Security.Claims.ClaimsPrincipal(), null, "Administrator")).Succeeded);
    }
    [Fact]
    public async Task LoginRateLimitAndOriginValidationAreEnforcedOverHttps()
    {
        var state = material.State(); new AdministratorIdentity(state, TimeProvider.System).SetPassword("synthetic-passphrase", false);
        var port = Port(); await using var host = Host(state, true, port); await host.StartAsync(); using var client = Client(port);
        var token = await Csrf(client);
        using var foreign = new HttpRequestMessage(HttpMethod.Post, "/api/admin/login") { Content = JsonContent.Create(new { password = "synthetic-passphrase" }) };
        foreign.Headers.Add("Origin", "https://untrusted.test"); foreign.Headers.Add("X-CSRF", token);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(foreign)).StatusCode);
        for (var i = 0; i < 4; i++) Assert.Equal(HttpStatusCode.Unauthorized, (await Mutation(client, HttpMethod.Post, "/api/admin/login", new { password = "synthetic-wrong-passphrase" }, token)).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await Mutation(client, HttpMethod.Post, "/api/admin/login", new { password = "synthetic-passphrase" }, token)).StatusCode);
        await host.StopAsync();
    }
    [Fact]
    public async Task DestinationPinningAndRedirectRejectionHoldAtTheSocketLayer()
    {
        var builder = WebApplication.CreateBuilder(); builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var upstream = builder.Build(); var followed = false;
        upstream.MapGet("/api/start", () => Microsoft.AspNetCore.Http.Results.Redirect("/api/redirected"));
        upstream.MapGet("/api/redirected", () => { followed = true; return "unexpected"; });
        await upstream.StartAsync();
        var address = upstream.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        var targets = new ConnectionTargets([address + "/api/"], ["127.0.0.1"]);
        using var client = new HttpClient(targets.Handler());
        Assert.Equal(HttpStatusCode.Found, (await client.GetAsync(address + "/api/start")).StatusCode); Assert.False(followed);
        var blocked = new ConnectionTargets([address + "/api/"], ["192.0.2.1"]);
        using var denied = new HttpClient(blocked.Handler());
        await Assert.ThrowsAsync<HttpRequestException>(() => denied.GetAsync(address + "/api/start"));
        await upstream.StopAsync();
    }
}
