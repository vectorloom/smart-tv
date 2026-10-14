namespace SmartTv;

public sealed record SaveSettingsRequest(string Revision, string BaseUrl, string? ReplacementKey, Guid[] AlbumIds);
public sealed record ImportSettingsRequest(string Revision);

public sealed class SettingsManager(SettingsStore store, ConnectionTargets targets, IHttpClientFactory factory)
{
    private HttpClient Client() => factory.CreateClient("immich");
    private ImmichClient Adapter(HttpClient http, ImmichSettings settings) => new(http, settings);
    public async Task<AdminAlbum[]> Albums(CancellationToken ct)
    {
        var settings = store.Snapshot(); targets.Require(settings.BaseUrl.AbsoluteUri);
        using var http = Client();
        return await Adapter(http, settings).AccessibleAlbums(ct);
    }
    public async Task<Media> Thumbnail(Guid album, CancellationToken ct)
    {
        using var http = Client();
        var settings = store.Snapshot(); targets.Require(settings.BaseUrl.AbsoluteUri);
        var all = await Adapter(http, settings).AccessibleAlbums(ct);
        var item = all.FirstOrDefault(a => a.Id == album) ?? throw new DashboardException(404, "Album not accessible.");
        var candidate = settings with { AlbumIds = [album] };
        var adapter = Adapter(http, candidate);
        var photo = (await adapter.Photos(album, 1, ct)).Items.FirstOrDefault();
        if (photo == null) throw new DashboardException(404, "Album has no available photo thumbnail.");
        return await adapter.Image(album, photo.Id, "thumbnail", ct);
    }
    public async Task<SettingsView> Save(SaveSettingsRequest request, CancellationToken ct)
    {
        if (request.AlbumIds == null || request.AlbumIds.Length > 1000 || request.AlbumIds.Any(id => id == Guid.Empty)) throw new DashboardException(400, "Invalid album selection.");
        var url = targets.Require(request.BaseUrl);
        if (request.ReplacementKey is { Length: > 4096 } || request.ReplacementKey?.Any(char.IsControl) == true) throw new DashboardException(400, "Invalid replacement key.");
        // A replacement can repair a lost/unreadable old key: never decrypt it first.
        var key = request.ReplacementKey ?? store.Snapshot().ApiKey;
        var candidate = new ImmichSettings(url, key, request.AlbumIds.ToHashSet());
        await Validate(candidate, ct);
        return store.Commit(candidate, request.Revision);
    }
    public async Task<SettingsView> Import(string revision, CancellationToken ct)
    {
        var candidate = store.EnvironmentSettings;
        targets.Require(candidate.BaseUrl.AbsoluteUri);
        await Validate(candidate, ct);
        return store.Commit(candidate, revision);
    }
    private async Task Validate(ImmichSettings candidate, CancellationToken ct)
    {
        if (!targets.HasPinnedAddresses) throw new DashboardException(503, "Configure deployment-approved Immich IP addresses before managing settings.");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(60));
        ct = deadline.Token;
        using var http = Client();
        var adapter = Adapter(http, candidate);
        await adapter.ValidateVersion(ct);
        var albums = await adapter.AccessibleAlbums(ct);
        if (candidate.AlbumIds.Any(id => !albums.Any(a => a.Id == id))) throw new DashboardException(400, "One or more selected albums are no longer accessible.");
        // Recheck each selected album through the actual shared-aware search API.
        foreach (var id in candidate.AlbumIds) await adapter.Photos(id, 1, ct);
        // Probe actual image permission, even if the selection itself is empty.
        // Bound work for an account whose available albums contain no usable images.
        foreach (var album in albums.Take(50))
        {
            var probe = Adapter(http, candidate with { AlbumIds = [album.Id] });
            var page = await probe.Photos(album.Id, 1, ct);
            var photo = page.Items.FirstOrDefault();
            if (photo == null) continue;
            await probe.Image(album.Id, photo.Id, "thumbnail", ct);
            return;
        }
        throw new DashboardException(400, "Validation incomplete: no accessible photo was found in the first 50 albums to verify thumbnail permission. Add an accessible photo and retry.");
    }
}
