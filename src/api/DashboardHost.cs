using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace SmartTv;

public static class DashboardHost
{
    public static WebApplication Build(string[] args, Action<WebApplicationBuilder>? configure = null, string? webRoot = null)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = args, WebRootPath = webRoot });
        configure?.Invoke(builder);
        var config = builder.Configuration;
        var environment = ImmichSettings.FromConfiguration(config);
        var weatherOptions = WeatherOptions.FromConfiguration(config);
        var administrator = config.GetValue<bool>("Administrator:Enabled");
        var port = config.GetValue("Administrator:Port", 8443);
        var directory = config["Settings:Directory"];
        if (administrator)
        {
            if (directory == null || port < 1024 || port > 65535 || config.GetSection("Kestrel:Endpoints").GetChildren().Any())
                throw new InvalidOperationException("Administrator configuration is invalid.");
            var certificate = X509Certificate2.CreateFromPemFile(config["Administrator:Certificate"]!, config["Administrator:PrivateKey"]!);
            if (certificate.NotAfter.ToUniversalTime() <= DateTime.UtcNow || certificate.NotBefore.ToUniversalTime() > DateTime.UtcNow)
                throw new InvalidOperationException("Administrator TLS certificate is expired or not yet valid.");
            // Ignore ASPNETCORE_URLS in admin mode; never bind any LAN interface.
            builder.WebHost.ConfigureKestrel(options => {
                options.Limits.MaxRequestBodySize = 64 * 1024;
                options.Listen(IPAddress.Loopback, port, listen => listen.UseHttps(certificate));
            });
            // Authentication cookies expire on restart, independent of settings keys.
            builder.Services.AddDataProtection().UseEphemeralDataProtectionProvider();
            AdministratorEndpoints.AddServices(builder.Services, directory);
        }
        var targets = new ConnectionTargets(
            (config["Immich:Targets"] ?? environment.BaseUrl.AbsoluteUri).Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
            (config["Immich:AllowedAddresses"] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        if (directory != null && !targets.HasPinnedAddresses) throw new InvalidOperationException("Managed settings require deployment-approved destination IP addresses.");
        builder.Services.AddSingleton(targets);
        builder.Services.AddSingleton(new SettingsStore(directory, environment, config["Settings:WrappingCertificate"], config["Settings:WrappingKey"], administrator));
        builder.Services.AddSingleton(TimeProvider.System);
        builder.Services.AddSingleton<RemoteControl>();
        builder.Services.AddHttpClient("immich", client => client.Timeout = TimeSpan.FromSeconds(30))
            .ConfigurePrimaryHttpMessageHandler(targets.Handler);
        builder.Services.AddHttpClient("weather", client => client.Timeout = TimeSpan.FromSeconds(15));
        builder.Services.AddSingleton(sp => new WeatherForecastService(
            sp.GetRequiredService<IHttpClientFactory>().CreateClient("weather"),
            weatherOptions, sp.GetRequiredService<TimeProvider>()));
        builder.Services.AddScoped(sp => {
            var settings = sp.GetRequiredService<SettingsStore>().Snapshot();
            targets.Require(settings.BaseUrl.AbsoluteUri);
            return new ImmichClient(sp.GetRequiredService<IHttpClientFactory>().CreateClient("immich"), settings);
        });
        builder.Services.AddScoped<SettingsManager>();
        builder.Logging.AddFilter("System.Net.Http.HttpClient", LogLevel.None);
        builder.Logging.AddFilter("Microsoft.AspNetCore.Hosting.Diagnostics", LogLevel.Warning);
        // Framework antiforgery failures must not include submitted payloads in logs.
        builder.Logging.AddFilter("Microsoft.AspNetCore.Antiforgery", LogLevel.None);
        var app = builder.Build();
        app.Use(async (context, next) => {
            context.Response.Headers["X-Content-Type-Options"] = "nosniff";
            context.Response.Headers["Referrer-Policy"] = "no-referrer";
            context.Response.Headers["Content-Security-Policy"] = "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
            if (administrator || context.Request.Path.StartsWithSegments("/api")) context.Response.Headers.CacheControl = "no-store";
            // Use the actual socket endpoint; no ForwardedHeaders middleware is enabled.
            if (administrator)
            {
                if (!AdministratorEndpoints.IsAdminTransport(context, port) || context.Request.Host.Host != "localhost" ||
                    (context.Request.Path.StartsWithSegments("/api") && !context.Request.Path.StartsWithSegments("/api/admin")))
                { context.Response.StatusCode = 404; return; }
            }
            else if (context.Request.Path.StartsWithSegments("/settings") || context.Request.Path.StartsWithSegments("/api/admin"))
            { context.Response.StatusCode = 404; return; }
            try { await next(context); }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
            catch (Exception error) when (error is DashboardException or HttpRequestException or JsonException or InvalidOperationException or KeyNotFoundException or FormatException or OperationCanceledException or IOException or CryptographicException or UnauthorizedAccessException or BadHttpRequestException)
            {
                if (context.Response.HasStarted) { context.Abort(); return; }
                context.Response.StatusCode = error is DashboardException known ? known.Status : error is BadHttpRequestException ? 400 : 502;
                await context.Response.WriteAsJsonAsync(new { message = error is DashboardException safe ? safe.Message : "The operation could not complete. Existing settings were retained." });
            }
        });
        if (administrator)
        {
            app.UseAuthentication();
            app.UseAuthorization();
            app.Use(AdministratorEndpoints.Guard);
            AdministratorEndpoints.Map(app);
        }
        else
        {
            app.Services.GetRequiredService<RemoteControl>().StartCleanup();
            app.UseWebSockets();
            app.Map("/api/remote", RemoteControl.Endpoint);
            app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));
            app.MapGet("/api/weather", async (WeatherForecastService weather, CancellationToken ct) =>
                Results.Ok(await weather.GetForecast(ct)));
            app.MapGet("/api/albums", (ImmichClient client, CancellationToken ct) => client.Albums(ct));
            app.MapGet("/api/albums/{album:guid}/photos", (Guid album, int? page, ImmichClient client, CancellationToken ct) => client.Photos(album, page ?? 1, ct));
            app.MapGet("/api/albums/{album:guid}/photos/{asset:guid}/image", async (Guid album, Guid asset, string? size, ImmichClient client, HttpContext context, CancellationToken ct) => {
                var media = await client.Image(album, asset, size ?? "thumbnail", ct);
                context.Response.Headers.CacheControl = "private, max-age=60";
                return Results.File(media.Bytes, media.ContentType);
            });
        }
        app.UseDefaultFiles(); app.UseStaticFiles();
        app.Map("/api/{**path}", () => Results.NotFound(new { message = "Endpoint not found." }));
        app.MapFallbackToFile("index.html");
        return app;
    }
}
