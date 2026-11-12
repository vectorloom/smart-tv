using System.Collections.Concurrent;
using Microsoft.Extensions.Caching.Memory;

namespace SmartTv;

/// <summary>
/// Size-bounded in-memory cache for proxied Immich images, so the TV's slideshow and album
/// grids do not re-download the same bytes. Entries are charged by byte length against
/// <see cref="DefaultLimitBytes"/> and expire after <see cref="DefaultLifetime"/>.
/// </summary>
/// <remarks>
/// A cache hit still enforces the configured album selection, but skips the per-request
/// Immich membership search. A photo removed from an album upstream can therefore remain
/// viewable here until its entry expires.
/// </remarks>
public sealed class ImageCache : IDisposable
{
    public const long DefaultLimitBytes = 200L * 1024 * 1024;
    public static readonly TimeSpan DefaultLifetime = TimeSpan.FromMinutes(30);
    private readonly MemoryCache cache;
    private readonly TimeSpan lifetime;
    private readonly ConcurrentDictionary<(Guid, Guid, string), Lazy<Task<Media>>> inFlight = new();

    public ImageCache(long limitBytes = DefaultLimitBytes, TimeSpan? lifetime = null)
    {
        cache = new MemoryCache(new MemoryCacheOptions { SizeLimit = limitBytes });
        this.lifetime = lifetime ?? DefaultLifetime;
    }

    public async Task<Media> Get(ImmichClient client, Guid album, Guid asset, string size, CancellationToken ct)
    {
        client.EnsureSelected(album);
        var key = (album, asset, size);
        if (cache.TryGetValue(key, out Media? hit) && hit is not null) return hit;
        // Concurrent requests for the same image (e.g. a prefetch racing the TV) share one
        // upstream download. The shared fetch is not tied to any one caller's cancellation.
        var load = inFlight.GetOrAdd(key, missing => new Lazy<Task<Media>>(async () => {
            try
            {
                var media = await client.Image(album, asset, size, CancellationToken.None);
                cache.Set(key, media, new MemoryCacheEntryOptions { Size = media.Bytes.Length, AbsoluteExpirationRelativeToNow = lifetime });
                return media;
            }
            finally { inFlight.TryRemove(key, out _); }
        }));
        return await load.Value.WaitAsync(ct);
    }

    public void Dispose() => cache.Dispose();
}

public sealed record SlideshowPhoto(Guid AlbumId, string AlbumName, Guid PhotoId, string? TakenAt, int Index, int Total);

/// <summary>
/// Picks random photos across the selected albums for the home-screen slideshow and keeps
/// one pick queued with its preview already in <see cref="ImageCache"/>.
/// </summary>
/// <remarks>
/// Albums are chosen with probability proportional to the square root of their size: a
/// 1,000-photo album is shown about 3× as often as a 100-photo album, not 10×. Big albums
/// get more airtime without drowning out small ones, and small albums are never starved.
/// The photo is then chosen uniformly within that album.
/// </remarks>
public sealed class SlideshowService(IServiceScopeFactory scopes, ImageCache images, TimeProvider clock, Func<double>? random = null)
{
    public static readonly TimeSpan PhotoListLifetime = TimeSpan.FromMinutes(30);
    private const int MaxPages = 1000;
    private readonly Func<double> random = random ?? Random.Shared.NextDouble;
    private readonly ConcurrentDictionary<Guid, (DateTimeOffset Loaded, Photo[] Photos)> photoLists = new();
    private Task<SlideshowPhoto?>? queued;

    public async Task<SlideshowPhoto?> Next(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var client = scope.ServiceProvider.GetRequiredService<ImmichClient>();
        var albums = await client.Albums(ct);
        SlideshowPhoto? pick = null;
        if (Interlocked.Exchange(ref queued, null) is { } ready)
        {
            try { pick = await ready.WaitAsync(ct); }
            catch (Exception) when (!ct.IsCancellationRequested) { }
            // The selection may have changed in admin settings since this was queued.
            if (pick is not null && !albums.Any(a => a.Id == pick.AlbumId)) pick = null;
        }
        pick ??= await Pick(client, albums, ct);
        if (pick is not null) Volatile.Write(ref queued, Prefetch());
        return pick;
    }

    private Task<SlideshowPhoto?> Prefetch() => Task.Run(async () => {
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            using var scope = scopes.CreateScope();
            var client = scope.ServiceProvider.GetRequiredService<ImmichClient>();
            var pick = await Pick(client, await client.Albums(timeout.Token), timeout.Token);
            if (pick is not null) await images.Get(client, pick.AlbumId, pick.PhotoId, "preview", timeout.Token);
            return pick;
        }
        catch (Exception) { return null; }
    });

    public async Task<SlideshowPhoto?> Pick(ImmichClient client, Album[] albums, CancellationToken ct)
    {
        var candidates = albums.Where(a => a.AssetCount > 0).ToList();
        while (candidates.Count > 0)
        {
            var album = Choose(candidates, random());
            var photos = await Photos(client, album.Id, ct);
            if (photos.Length == 0) { candidates.Remove(album); continue; }  // e.g. a video-only album
            var index = Math.Min(photos.Length - 1, (int)(random() * photos.Length));
            var photo = photos[index];
            return new(album.Id, album.Name, photo.Id, photo.TakenAt, index + 1, photos.Length);
        }
        return null;
    }

    public static Album Choose(IReadOnlyList<Album> albums, double r)
    {
        var weights = albums.Select(a => Math.Sqrt(a.AssetCount)).ToArray();
        var target = r * weights.Sum();
        for (var i = 0; i < albums.Count; i++)
        {
            target -= weights[i];
            if (target < 0) return albums[i];
        }
        return albums[^1];
    }

    private async Task<Photo[]> Photos(ImmichClient client, Guid album, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        if (photoLists.TryGetValue(album, out var entry) && now - entry.Loaded < PhotoListLifetime) return entry.Photos;
        var items = new List<Photo>();
        var seen = new HashSet<Guid>();
        int? page = 1;
        for (var count = 0; page is int current && count < MaxPages; count++)
        {
            var result = await client.Photos(album, current, ct);
            items.AddRange(result.Items.Where(p => seen.Add(p.Id)));
            page = result.NextPage;
        }
        var photos = items.ToArray();
        photoLists[album] = (now, photos);
        return photos;
    }
}
