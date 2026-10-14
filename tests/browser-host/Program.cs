using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using SmartTv;

// Separate test-only executable. It is never copied to the Docker runtime image.
var project = Path.GetFullPath(args[0]);
var root = Path.Combine(project, ".local", "settings-browser");
if (Directory.Exists(root)) Directory.Delete(root, true); // Only this synthetic fixture directory.
Directory.CreateDirectory(root);
var material = Path.Combine(root, "material"); Provisioning.Material(material);
var state = Path.Combine(root, "state");
new AdministratorIdentity(state, TimeProvider.System).SetPassword("synthetic-browser-passphrase", false);
const string owned = "11111111-1111-4111-8111-111111111111";
const string shared = "33333333-3333-4333-8333-333333333333";
const string asset = "22222222-2222-4222-8222-222222222222";
var fakeBuilder = WebApplication.CreateBuilder(); fakeBuilder.Logging.ClearProviders();
fakeBuilder.WebHost.UseUrls("http://127.0.0.1:5091");
var fake = fakeBuilder.Build();
fake.Use(async (context, next) => {
    if (context.Request.Headers["x-api-key"] != "synthetic-browser-key" && context.Request.Headers["x-api-key"] != "synthetic-browser-replacement") { context.Response.StatusCode = 401; return; }
    await next(context);
});
fake.MapGet("/api/server/version", () => new { major = 3, minor = 1, patch = 0 });
fake.MapGet("/api/albums", (HttpContext context) => new[] { new {
    id = context.Request.Query["isShared"] == "true" ? shared : owned,
    albumName = context.Request.Query["isShared"] == "true" ? "Shared holiday" : "My album",
    assetCount = 1, albumThumbnailAssetId = asset
} });
fake.MapPost("/api/search/metadata", () => new { assets = new { items = new[] { new { id = asset, originalFileName = "Synthetic photo", type = "IMAGE", isTrashed = false } }, nextPage = (string?)null } });
fake.MapGet("/api/assets/{id}/thumbnail", () => Results.File(Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5e8AAAAASUVORK5CYII="), "image/png"));
Dictionary<string, string?> Configuration(bool admin) => new() {
    ["Administrator:Enabled"] = admin.ToString(), ["Administrator:Port"] = "5443",
    ["Administrator:Certificate"] = Path.Combine(material, "localhost.crt"),
    ["Administrator:PrivateKey"] = Path.Combine(material, "localhost.key"),
    ["Settings:Directory"] = state, ["Settings:WrappingCertificate"] = Path.Combine(material, "wrapping.crt"),
    ["Settings:WrappingKey"] = Path.Combine(material, "wrapping.key"),
    ["Immich:BaseUrl"] = "http://127.0.0.1:5091/api/", ["Immich:Targets"] = "http://127.0.0.1:5091/api/", ["Immich:AllowedAddresses"] = "127.0.0.1",
    ["Immich:ApiKey"] = "synthetic-browser-key", ["Immich:AlbumIds"] = owned,
};
var webRoot = Path.Combine(project, "src", "web", "dist");
WebApplication Host(bool admin) => DashboardHost.Build(admin ? [] : ["--urls", "http://127.0.0.1:5082"], builder => {
    builder.Configuration.AddInMemoryCollection(Configuration(admin)); builder.Logging.ClearProviders();
}, webRoot);
await using var publicHost = Host(false);
await using var adminHost = Host(true);
await fake.StartAsync(); await adminHost.StartAsync(); await publicHost.StartAsync();
Console.WriteLine("Synthetic settings test hosts ready (public 5082, HTTPS admin 5443).");
await publicHost.WaitForShutdownAsync();
await adminHost.StopAsync(); await fake.StopAsync(); await fake.DisposeAsync();
