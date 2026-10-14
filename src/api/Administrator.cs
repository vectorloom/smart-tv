using System.Collections.Concurrent;
using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;

namespace SmartTv;

public sealed record AdministratorRecord(int Format, string PasswordHash, Guid Stamp);
public sealed record LoginRequest(string Password);

public sealed class AdministratorIdentity(string directory, TimeProvider clock)
{
    public const string Scheme = "Administrator";
    private readonly PasswordHasher<AdministratorRecord> hasher = new(Options.Create(new PasswordHasherOptions { IterationCount = 600_000 }));
    private readonly ConcurrentDictionary<string, Session> sessions = new();
    private sealed record Session(Guid Stamp, DateTimeOffset Created, DateTimeOffset LastSeen);
    private string PathName => Path.Combine(directory, "administrator.json");
    private AdministratorRecord? Read() => PrivateFiles.Read<AdministratorRecord>(PathName);
    public void SetPassword(string password, bool reset)
    {
        if (password.Length is < 14 or > 256) throw new DashboardException(400, "Use an administrator passphrase between 14 and 256 characters.");
        if (!reset && File.Exists(PathName)) throw new DashboardException(409, "Administrator already exists; use explicit recovery instead.");
        var record = new AdministratorRecord(1, "", Guid.NewGuid());
        PrivateFiles.Json(PathName, record with { PasswordHash = hasher.HashPassword(record, password) });
        sessions.Clear();
    }
    public ClaimsPrincipal? Login(string password)
    {
        if (password.Length is < 14 or > 256) return null;
        AdministratorRecord? record;
        try { record = Read(); } catch { return null; }
        if (record == null || record.Format != 1 || hasher.VerifyHashedPassword(record, record.PasswordHash, password) == PasswordVerificationResult.Failed) return null;
        var now = clock.GetUtcNow();
        foreach (var entry in sessions.Where(s => now - s.Value.LastSeen >= TimeSpan.FromMinutes(15) || now - s.Value.Created >= TimeSpan.FromHours(8))) sessions.TryRemove(entry.Key, out _);
        if (sessions.Count >= 8) return null;
        var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        sessions[id] = new(record.Stamp, now, now);
        return new(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, id), new Claim(ClaimTypes.Role, "Administrator")], Scheme));
    }
    public bool Validate(ClaimsPrincipal? principal)
    {
        var id = principal?.FindFirstValue(ClaimTypes.NameIdentifier);
        if (id == null || !sessions.TryGetValue(id, out var session)) return false;
        var now = clock.GetUtcNow();
        try
        {
            if (Read()?.Stamp != session.Stamp || now - session.LastSeen >= TimeSpan.FromMinutes(15) || now - session.Created >= TimeSpan.FromHours(8))
            { sessions.TryRemove(id, out _); return false; }
        }
        catch { return false; }
        sessions.TryUpdate(id, session with { LastSeen = now }, session);
        return true;
    }
    public void Logout(ClaimsPrincipal principal)
    {
        var id = principal.FindFirstValue(ClaimTypes.NameIdentifier);
        if (id != null) sessions.TryRemove(id, out _);
    }
}

// Global budgets intentionally avoid trusting forwarded client IPs. The only
// network path to this single-administrator listener is local/SSH-forwarded HTTPS.
public sealed class AdministratorLimits(TimeProvider clock)
{
    private readonly object gate = new();
    private readonly Dictionary<string, (DateTimeOffset Start, int Count)> windows = [];
    public bool Allow(string bucket, int maximum)
    {
        lock (gate)
        {
            var now = clock.GetUtcNow();
            if (!windows.TryGetValue(bucket, out var current) || now - current.Start >= TimeSpan.FromMinutes(1)) current = (now, 0);
            windows[bucket] = (current.Start, current.Count + 1);
            return current.Count < maximum;
        }
    }
}

public static class AdministratorEndpoints
{
    public static bool IsAdminTransport(HttpContext context, int port) =>
        context.Connection.LocalIpAddress is {} local && IPAddress.IsLoopback(local) &&
        context.Connection.LocalPort == port && context.Request.IsHttps;

    public static void AddServices(IServiceCollection services, string directory)
    {
        services.AddSingleton(sp => new AdministratorIdentity(directory, sp.GetRequiredService<TimeProvider>()));
        services.AddSingleton<AdministratorLimits>();
        services.AddAntiforgery(options => {
            options.HeaderName = "X-CSRF";
            options.Cookie.Name = "__Host-smart-tv-csrf";
            options.Cookie.HttpOnly = true; options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
            options.Cookie.SameSite = SameSiteMode.Strict;
        });
        services.AddAuthentication(AdministratorIdentity.Scheme).AddCookie(AdministratorIdentity.Scheme, options => {
            options.Cookie.Name = "__Host-smart-tv-admin"; options.Cookie.Path = "/";
            options.Cookie.SecurePolicy = CookieSecurePolicy.Always; options.Cookie.HttpOnly = true;
            options.Cookie.SameSite = SameSiteMode.Strict;
            options.ExpireTimeSpan = TimeSpan.FromHours(8); options.SlidingExpiration = false;
            options.Events.OnRedirectToLogin = context => { context.Response.StatusCode = 401; return Task.CompletedTask; };
            options.Events.OnRedirectToAccessDenied = context => { context.Response.StatusCode = 403; return Task.CompletedTask; };
            options.Events.OnValidatePrincipal = context => {
                if (!context.HttpContext.RequestServices.GetRequiredService<AdministratorIdentity>().Validate(context.Principal)) context.RejectPrincipal();
                return Task.CompletedTask;
            };
        });
        services.AddAuthorization(options => options.AddPolicy("Administrator", policy =>
            policy.AddAuthenticationSchemes(AdministratorIdentity.Scheme).RequireAuthenticatedUser().RequireRole("Administrator")));
    }
    public static void Map(WebApplication app)
    {
        var admin = app.MapGroup("/api/admin").RequireAuthorization("Administrator");
        admin.MapGet("/csrf", (IAntiforgery antiforgery, HttpContext context) =>
            Results.Ok(new { token = antiforgery.GetAndStoreTokens(context).RequestToken })).AllowAnonymous();
        admin.MapPost("/login", async (LoginRequest request, AdministratorIdentity identity, HttpContext context) => {
            var principal = identity.Login(request.Password ?? "");
            if (principal == null) return Results.Json(new { message = "Sign-in failed. Check your passphrase or use host-side recovery." }, statusCode: 401);
            await context.SignInAsync(AdministratorIdentity.Scheme, principal, new AuthenticationProperties { IsPersistent = false });
            return Results.Ok(new { authenticated = true });
        }).AllowAnonymous();
        admin.MapGet("/session", () => Results.Ok(new { authenticated = true }));
        admin.MapPost("/logout", async (AdministratorIdentity identity, HttpContext context) => {
            identity.Logout(context.User); await context.SignOutAsync(AdministratorIdentity.Scheme);
            return Results.NoContent();
        });
        admin.MapGet("/settings", (SettingsStore store, ConnectionTargets targets) => Results.Ok(new { settings = store.View(), targets = targets.Targets.Select(t => t.AbsoluteUri) }));
        admin.MapPut("/settings", (SaveSettingsRequest request, SettingsManager manager, CancellationToken ct) => manager.Save(request, ct));
        admin.MapPost("/import", (ImportSettingsRequest request, SettingsManager manager, CancellationToken ct) => manager.Import(request.Revision, ct));
        admin.MapGet("/albums", (SettingsManager manager, CancellationToken ct) => manager.Albums(ct));
        admin.MapGet("/albums/{album:guid}/thumbnail", async (Guid album, SettingsManager manager, CancellationToken ct) => {
            var media = await manager.Thumbnail(album, ct); return Results.File(media.Bytes, media.ContentType);
        });
    }
    public static async Task Guard(HttpContext context, RequestDelegate next)
    {
        if (context.Request.Path.StartsWithSegments("/api/admin"))
        {
            var limits = context.RequestServices.GetRequiredService<AdministratorLimits>();
            var mutation = context.Request.Method is not ("GET" or "HEAD");
            var login = context.Request.Path == "/api/admin/login";
            if (!limits.Allow("all", 240) || (login && !limits.Allow("login", 5)) ||
                (mutation && !login && context.Request.Path != "/api/admin/logout" && !limits.Allow("writes", 10)))
            { context.Response.StatusCode = 429; context.Response.Headers.RetryAfter = "60"; return; }
            if (mutation)
            {
                var origin = context.Request.Headers.Origin.ToString();
                if (origin != $"https://{context.Request.Host}") { context.Response.StatusCode = 403; return; }
                try { await context.RequestServices.GetRequiredService<IAntiforgery>().ValidateRequestAsync(context); }
                catch (AntiforgeryValidationException) { context.Response.StatusCode = 400; return; }
            }
        }
        await next(context);
    }
}
