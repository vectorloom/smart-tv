using System.Net;
using System.Text;
using System.Text.Json;
using SmartTv;
using Xunit;

public class ImmichClientTests
{
    private static readonly Guid AlbumId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid AssetId = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly Guid Other = Guid.Parse("33333333-3333-4333-8333-333333333333");
    private static readonly CancellationToken Ct = CancellationToken.None;

    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> handle) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => handle(request);
    }

    private static ImmichClient Client(Func<HttpRequestMessage, Task<HttpResponseMessage>> handle, string key = "test-only-key", HashSet<Guid>? albums = null)
        => new(new HttpClient(new Handler(handle)), new(new Uri("http://immich.test/api/"), key, albums ?? [AlbumId]));

    private static HttpResponseMessage Json(object body) => new(HttpStatusCode.OK)
    { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };

    private static object Asset(Guid? id = null, string type = "IMAGE", bool trashed = false) =>
        new { id = id ?? AssetId, type, isTrashed = trashed, originalFileName = "photo.jpg" };
    private static object Search(object[] items, string? next = null) => new { assets = new { items, nextPage = next } };

    [Fact]
    public async Task AlbumsUseVersionedContractAndFilterSelection()
    {
        var client = Client(request =>
        {
            Assert.Equal(HttpMethod.Get, request.Method);
            Assert.Equal("/api/albums", request.RequestUri!.AbsolutePath);
            Assert.Contains(request.RequestUri.Query, new[] { "?isOwned=true", "?isShared=true" });
            Assert.Equal("test-only-key", request.Headers.GetValues("x-api-key").Single());
            return Task.FromResult(Json(new[] {
                new { id = AlbumId, albumName = "Memories", assetCount = 2, albumThumbnailAssetId = (Guid?)AssetId },
                new { id = Other, albumName = "Private", assetCount = 9, albumThumbnailAssetId = (Guid?)null }
            }));
        });
        var album = Assert.Single(await client.Albums(Ct));
        Assert.Equal("Memories", album.Name);
        Assert.Equal(2, album.AssetCount);
        Assert.Equal(AssetId, album.ThumbnailId);
    }

    [Fact]
    public async Task EmptySelectionExposesNothingAndMakesNoRequest()
    {
        var client = Client(_ => throw new Exception("Unexpected upstream call"), albums: []);
        Assert.Empty(await client.Albums(Ct));
    }

    [Fact]
    public async Task PhotoSearchFiltersAlbumAndUsesNextPageToken()
    {
        var client = Client(async request =>
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.EndsWith("/api/search/metadata", request.RequestUri!.ToString());
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            Assert.Equal(AlbumId, body.RootElement.GetProperty("albumIds")[0].GetGuid());
            Assert.Equal(2, body.RootElement.GetProperty("page").GetInt32());
            Assert.Equal("IMAGE", body.RootElement.GetProperty("type").GetString());
            Assert.False(body.RootElement.TryGetProperty("id", out _));
            return Json(Search([Asset(), Asset(Other, "VIDEO"), Asset(Other, trashed: true)], "3"));
        });
        var page = await client.Photos(AlbumId, 2, Ct);
        Assert.Equal(AssetId, Assert.Single(page.Items).Id);
        Assert.Equal(3, page.NextPage);
    }

    [Fact]
    public async Task UnselectedAlbumIsRejectedBeforeNetworkAccess()
    {
        var client = Client(_ => throw new Exception("Unexpected upstream call"));
        var error = await Assert.ThrowsAsync<DashboardException>(() => client.Photos(Other, 1, Ct));
        Assert.Equal(404, error.Status);
    }

    [Fact]
    public async Task InvalidPageIsRejectedBeforeNetworkAccess()
    {
        var client = Client(_ => throw new Exception("Unexpected upstream call"));
        Assert.Equal(400, (await Assert.ThrowsAsync<DashboardException>(() => client.Photos(AlbumId, 0, Ct))).Status);
    }

    [Theory]
    [InlineData("1")]
    [InlineData("not-a-page")]
    public async Task BrokenPaginationIsRejected(string next)
    {
        var client = Client(_ => Task.FromResult(Json(Search([], next))));
        await Assert.ThrowsAsync<JsonException>(() => client.Photos(AlbumId, 1, Ct));
    }

    [Fact]
    public async Task ImageCannotBypassAlbumMembership()
    {
        var calls = 0;
        var client = Client(_ => { calls++; return Task.FromResult(Json(Search([]))); });
        var error = await Assert.ThrowsAsync<DashboardException>(() => client.Image(AlbumId, Other, "preview", Ct));
        Assert.Equal(404, error.Status);
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task ImageUsesPreviewAndNeverRequestsOriginal()
    {
        var calls = 0;
        var client = Client(async request =>
        {
            if (++calls == 1)
            {
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
                Assert.Equal(AssetId, body.RootElement.GetProperty("id").GetGuid());
                return Json(Search([Asset()]));
            }
            Assert.Equal($"http://immich.test/api/assets/{AssetId}/thumbnail?size=preview", request.RequestUri!.ToString());
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([1, 2, 3]) };
            response.Content.Headers.ContentType = new("image/jpeg");
            return response;
        });
        var media = await client.Image(AlbumId, AssetId, "preview", Ct);
        Assert.Equal("image/jpeg", media.ContentType);
        Assert.Equal(new byte[] { 1, 2, 3 }, media.Bytes);
    }

    [Theory]
    [InlineData("original")]
    [InlineData("fullsize")]
    [InlineData("../../secret")]
    public async Task UnsupportedImageSizesCannotReachUpstream(string size)
    {
        var client = Client(_ => throw new Exception("Unexpected upstream call"));
        Assert.Equal(400, (await Assert.ThrowsAsync<DashboardException>(() => client.Image(AlbumId, AssetId, size, Ct))).Status);
    }

    [Theory]
    [InlineData(401)]
    [InlineData(403)]
    [InlineData(500)]
    [InlineData(302)]
    public async Task ErrorsDoNotExposeUpstreamResponse(int status)
    {
        var client = Client(_ => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status)
        { Content = new StringContent("sensitive upstream details") }));
        var error = await Assert.ThrowsAsync<DashboardException>(() => client.Albums(Ct));
        Assert.Equal(502, error.Status);
        Assert.DoesNotContain("sensitive", error.Message);
        Assert.DoesNotContain("test-only-key", error.Message);
    }

    [Fact]
    public async Task MissingKeyFailsWithActionableSafeMessage()
    {
        var client = Client(_ => throw new Exception("Unexpected upstream call"), key: "");
        Assert.Equal(503, (await Assert.ThrowsAsync<DashboardException>(() => client.Albums(Ct))).Status);
    }
}
