using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using SmartTv;
using Xunit;

public class SlideshowTests
{
    private static readonly Guid Big = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid Small = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly Guid Videos = Guid.Parse("33333333-3333-4333-8333-333333333333");
    private static readonly Guid Unselected = Guid.Parse("44444444-4444-4444-8444-444444444444");

    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> handle) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => handle(request);
    }

    /// <summary>Fake Immich: albums Big (photos b0..b149 in two pages), Small (s0..s3), Videos (no images).</summary>
    private sealed class FakeImmich
    {
        public readonly ConcurrentBag<string> Requests = [];
        public static Guid Photo(char album, int index) => Guid.Parse($"{(album == 'b' ? "aaaaaaaa" : "bbbbbbbb")}-0000-4000-8000-{index:D12}");
        public HashSet<Guid> Selection = [Big, Small, Videos];

        public ImmichClient Client() => new(new HttpClient(new Handler(Handle)), new(new Uri("http://immich.test/api/"), "test-only-key", Selection));

        private async Task<HttpResponseMessage> Handle(HttpRequestMessage request)
        {
            var path = request.RequestUri!.PathAndQuery;
            Requests.Add(path);
            if (path.StartsWith("/api/albums"))
                return path.EndsWith("isShared=true") ? Json(Array.Empty<object>()) : Json(new object[] {
                    new { id = Big, albumName = "Big", assetCount = 150, albumThumbnailAssetId = (Guid?)null },
                    new { id = Small, albumName = "Small", assetCount = 4, albumThumbnailAssetId = (Guid?)null },
                    new { id = Videos, albumName = "Videos", assetCount = 9, albumThumbnailAssetId = (Guid?)null },
                    new { id = Unselected, albumName = "Hidden", assetCount = 900, albumThumbnailAssetId = (Guid?)null },
                });
            if (path == "/api/search/metadata")
            {
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
                var album = body.RootElement.GetProperty("albumIds")[0].GetGuid();
                var page = body.RootElement.GetProperty("page").GetInt32();
                if (body.RootElement.TryGetProperty("id", out var id))
                    return Json(Search([Asset(id.GetGuid())]));
                if (album == Big) return Json(Search(Enumerable.Range((page - 1) * 100, page == 1 ? 100 : 50).Select(i => Asset(Photo('b', i))).ToArray(), page == 1 ? "2" : null));
                if (album == Small) return Json(Search(Enumerable.Range(0, 4).Select(i => Asset(Photo('s', i))).ToArray()));
                return Json(Search([]));
            }
            if (path.Contains("/thumbnail"))
                return new(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[1000]) { Headers = { ContentType = new("image/jpeg") } } };
            return new(HttpStatusCode.NotFound);
        }

        private static object Asset(Guid id) => new { id, type = "IMAGE", isTrashed = false, originalFileName = "p.jpg", localDateTime = "2024-11-02T14:03:00.000Z" };
        private static object Search(object[] items, string? next = null) => new { assets = new { items, nextPage = next } };
        private static HttpResponseMessage Json(object body) => new(HttpStatusCode.OK)
        { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };
    }

    private static Album A(string name, int count) => new(Guid.NewGuid(), name, count, null);

    [Fact]
    public void AlbumWeightIsSquareRootOfSize()
    {
        var albums = new[] { A("hundred", 100), A("ten-thousand", 10000) };
        // sqrt weights 10 and 100: the small album owns the first 1/11 of the range.
        Assert.Equal("hundred", SlideshowService.Choose(albums, 0.09).Name);
        Assert.Equal("ten-thousand", SlideshowService.Choose(albums, 0.091).Name);
        Assert.Equal("ten-thousand", SlideshowService.Choose(albums, 0.999999).Name);
        var hits = Enumerable.Range(0, 11000).Count(i => SlideshowService.Choose(albums, i / 11000.0).Name == "hundred");
        Assert.InRange(hits, 990, 1010);
    }

    private static (SlideshowService Service, FakeImmich Immich, ImageCache Cache) Create(params double[] sequence)
    {
        var immich = new FakeImmich();
        var services = new ServiceCollection().AddScoped(_ => immich.Client()).BuildServiceProvider();
        var cache = new ImageCache();
        var queue = new Queue<double>(sequence);
        var service = new SlideshowService(services.GetRequiredService<IServiceScopeFactory>(), cache, TimeProvider.System,
            () => queue.Count > 0 ? queue.Dequeue() : 0.0);
        return (service, immich, cache);
    }

    [Fact]
    public async Task PickSpansAllPagesReportsPositionAndSkipsVideoOnlyAlbums()
    {
        var (service, immich, _) = Create(0.0, 0.99);
        var albums = await immich.Client().Albums(CancellationToken.None);
        Assert.DoesNotContain(albums, a => a.Id == Unselected);
        var pick = await service.Pick(immich.Client(), albums, CancellationToken.None);
        Assert.NotNull(pick);
        Assert.Equal(Big, pick.AlbumId);
        Assert.Equal((149, 150), (pick.Index, pick.Total));
        Assert.Equal(FakeImmich.Photo('b', 148), pick.PhotoId);
        Assert.Equal("2024-11-02T14:03:00.000Z", pick.TakenAt);

        // The video-only album is drawn first (r near 1), found empty, and skipped.
        (service, immich, _) = Create(0.99, 0.99, 0.5);
        pick = await service.Pick(immich.Client(), albums, CancellationToken.None);
        Assert.Equal(Small, pick!.AlbumId);
        Assert.Null(await service.Pick(immich.Client(), [], CancellationToken.None));
    }

    [Fact]
    public async Task NextReturnsQueuedPickWhosePreviewIsAlreadyCached()
    {
        var (service, immich, cache) = Create(0.0, 0.0, 0.0, 0.5);
        var first = await service.Next(CancellationToken.None);
        Assert.Equal(FakeImmich.Photo('b', 0), first!.PhotoId);
        // Wait for the background prefetch of the second pick (Big, photo 75) to land in the cache.
        var expected = FakeImmich.Photo('b', 75);
        for (var i = 0; i < 100 && !immich.Requests.Any(r => r.Contains($"{expected}/thumbnail?size=preview")); i++) await Task.Delay(20);
        var second = await service.Next(CancellationToken.None);
        Assert.Equal(expected, second!.PhotoId);
        var before = immich.Requests.Count;
        await cache.Get(immich.Client(), second.AlbumId, second.PhotoId, "preview", CancellationToken.None);
        Assert.Equal(before, immich.Requests.Count);
    }

    [Fact]
    public async Task CacheHitsSkipUpstreamButStillEnforceSelection()
    {
        var immich = new FakeImmich();
        using var cache = new ImageCache();
        var photo = FakeImmich.Photo('s', 1);
        await cache.Get(immich.Client(), Small, photo, "preview", CancellationToken.None);
        var before = immich.Requests.Count;
        var media = await cache.Get(immich.Client(), Small, photo, "preview", CancellationToken.None);
        Assert.Equal(1000, media.Bytes.Length);
        Assert.Equal(before, immich.Requests.Count);
        immich.Selection = [Big];
        await Assert.ThrowsAsync<DashboardException>(() => cache.Get(immich.Client(), Small, photo, "preview", CancellationToken.None));
    }

    [Fact]
    public async Task CacheRespectsByteLimit()
    {
        var immich = new FakeImmich();
        using var cache = new ImageCache(limitBytes: 2500);
        for (var i = 0; i < 4; i++) await cache.Get(immich.Client(), Small, FakeImmich.Photo('s', i), "preview", CancellationToken.None);
        // 4 × 1000 bytes cannot all fit in 2500: re-reading every image must go upstream at least once.
        var before = immich.Requests.Count;
        for (var i = 0; i < 4; i++) await cache.Get(immich.Client(), Small, FakeImmich.Photo('s', i), "preview", CancellationToken.None);
        Assert.True(immich.Requests.Count > before);
    }
}
