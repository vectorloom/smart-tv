using System.Net.Http.Json;
using System.Text.Json;

namespace SmartTv;

public sealed class DashboardException(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

public sealed record ImmichSettings(Uri BaseUrl, string ApiKey, HashSet<Guid> AlbumIds)
{
    public override string ToString() => "ImmichSettings (credentials redacted)";
    public static ImmichSettings FromConfiguration(IConfiguration config)
    {
        var url = config["Immich:BaseUrl"] ?? "http://localhost:2283/api/";
        if (!Uri.TryCreate(url.TrimEnd('/') + "/", UriKind.Absolute, out var uri) ||
            (uri.Scheme != "http" && uri.Scheme != "https") || !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            throw new InvalidOperationException("Immich base URL must be an HTTP(S) API URL without credentials or query parameters.");
        var ids = new HashSet<Guid>();
        foreach (var value in (config["Immich:AlbumIds"] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!Guid.TryParse(value, out var id)) throw new InvalidOperationException("Immich album selection must contain UUIDs.");
            ids.Add(id);
        }
        return new(uri, config["Immich:ApiKey"] ?? "", ids);
    }
}

public sealed record Album(Guid Id, string Name, int AssetCount, Guid? ThumbnailId);
public sealed record Photo(Guid Id, string Name);
public sealed record PhotoPage(Photo[] Items, int? NextPage);
public sealed record Media(byte[] Bytes, string ContentType);

public sealed class ImmichClient(HttpClient http, ImmichSettings settings)
{
    private void CheckConfigured()
    {
        if (string.IsNullOrWhiteSpace(settings.ApiKey) || settings.ApiKey.StartsWith("replace-"))
            throw new DashboardException(503, "Configure the dashboard's dedicated Immich API key.");
    }

    private void CheckAlbum(Guid id)
    {
        if (!settings.AlbumIds.Contains(id)) throw new DashboardException(404, "Album not selected.");
    }

    private async Task<HttpResponseMessage> Send(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        CheckConfigured();
        using var request = new HttpRequestMessage(method, new Uri(settings.BaseUrl, path));
        request.Headers.Add("x-api-key", settings.ApiKey);
        if (body is not null) request.Content = JsonContent.Create(body);
        var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
        {
            var status = (int)response.StatusCode;
            response.Dispose();
            throw new DashboardException(status == 404 ? 404 : 502,
                status is 401 or 403 ? "Immich denied access. Check the dedicated key's permissions and album access." : "Immich could not complete the request.");
        }
        return response;
    }

    private async Task<JsonDocument> Json(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        using var response = await Send(method, path, body, ct);
        var bytes = await LimitedBody(response, 8 * 1024 * 1024, ct);
        return JsonDocument.Parse(bytes);
    }

    public async Task<Album[]> Albums(CancellationToken ct)
    {
        CheckConfigured();
        if (settings.AlbumIds.Count == 0) return [];
        return (await AccessibleAlbums(ct)).Where(a => settings.AlbumIds.Contains(a.Id))
            .Select(a => new Album(a.Id, a.Name, a.AssetCount, a.ThumbnailId)).ToArray();
    }

    public async Task<AdminAlbum[]> AccessibleAlbums(CancellationToken ct)
    {
        var found = new Dictionary<Guid, AdminAlbum>();
        foreach (var query in new[] { "albums?isOwned=true", "albums?isShared=true" })
        {
            using var doc = await Json(HttpMethod.Get, query, null, ct);
            foreach (var a in doc.RootElement.EnumerateArray())
            {
                var id = a.GetProperty("id").GetGuid();
                var thumbnail = a.TryGetProperty("albumThumbnailAssetId", out var cover) && cover.ValueKind == JsonValueKind.String ? cover.GetGuid() : (Guid?)null;
                found[id] = new(id, a.GetProperty("albumName").GetString() ?? "Untitled album", a.GetProperty("assetCount").GetInt32(), thumbnail);
            }
        }
        return found.Values.OrderBy(a => a.Name).ToArray();
    }

    public async Task ValidateVersion(CancellationToken ct)
    {
        using var doc = await Json(HttpMethod.Get, "server/version", null, ct);
        // Versioned, tested contract. Unknown versions fail without changing settings.
        if (doc.RootElement.GetProperty("major").GetInt32() != 3 || doc.RootElement.GetProperty("minor").GetInt32() != 1)
            throw new DashboardException(400, "This Immich version is not supported by the validated 3.1.x adapter.");
    }

    private static async Task<byte[]> LimitedBody(HttpResponseMessage response, int limit, CancellationToken ct)
    {
        if (response.Content.Headers.ContentLength > limit) throw new DashboardException(502, "Immich response exceeds the size limit.");
        await using var input = await response.Content.ReadAsStreamAsync(ct);
        using var output = new MemoryStream();
        var buffer = new byte[81920];
        int read;
        while ((read = await input.ReadAsync(buffer, ct)) > 0)
        {
            if (output.Length + read > limit) throw new DashboardException(502, "Immich response exceeds the size limit.");
            await output.WriteAsync(buffer.AsMemory(0, read), ct);
        }
        return output.ToArray();
    }

    private async Task<JsonDocument> Search(Guid album, int page, Guid? asset, CancellationToken ct)
    {
        CheckAlbum(album);
        var query = new Dictionary<string, object>
        {
            ["albumIds"] = new[] { album }, ["type"] = "IMAGE", ["page"] = page,
            ["size"] = asset.HasValue ? 1 : 100, ["order"] = "asc", ["withDeleted"] = false,
            ["withExif"] = false, ["withPeople"] = false
        };
        if (asset.HasValue) query["id"] = asset.Value;
        return await Json(HttpMethod.Post, "search/metadata", query, ct);
    }

    public async Task<PhotoPage> Photos(Guid album, int page, CancellationToken ct)
    {
        if (page < 1) throw new DashboardException(400, "Page must be positive.");
        using var doc = await Search(album, page, null, ct);
        var assets = doc.RootElement.GetProperty("assets");
        var items = assets.GetProperty("items").EnumerateArray().Where(IsPhoto)
            .Select(a => new Photo(a.GetProperty("id").GetGuid(), a.GetProperty("originalFileName").GetString() ?? "Photo")).ToArray();
        var token = assets.GetProperty("nextPage").GetString();
        int? next = null;
        if (token is not null)
        {
            if (!int.TryParse(token, out var value) || value <= page) throw new JsonException("Invalid pagination.");
            next = value;
        }
        return new(items, next);
    }

    private static bool IsPhoto(JsonElement asset) => asset.GetProperty("type").GetString() == "IMAGE" &&
        !asset.GetProperty("isTrashed").GetBoolean();

    public async Task<Media> Image(Guid album, Guid asset, string size, CancellationToken ct)
    {
        if (size is not ("thumbnail" or "preview")) throw new DashboardException(400, "Unsupported image size.");
        // Recheck membership for each request; arbitrary asset IDs cannot bypass album selection.
        using var membership = await Search(album, 1, asset, ct);
        if (!membership.RootElement.GetProperty("assets").GetProperty("items").EnumerateArray()
            .Any(a => a.GetProperty("id").GetGuid() == asset && IsPhoto(a)))
            throw new DashboardException(404, "Photo not found in the selected album.");
        using var response = await Send(HttpMethod.Get, $"assets/{asset}/thumbnail?size={size}", null, ct);
        var type = response.Content.Headers.ContentType?.MediaType;
        if (type is not ("image/jpeg" or "image/png" or "image/webp" or "image/avif" or "image/gif"))
            throw new DashboardException(502, "Immich returned an unsupported image format.");
        return new(await LimitedBody(response, 32 * 1024 * 1024, ct), type);
    }
}

public sealed record AdminAlbum(Guid Id, string Name, int AssetCount, Guid? ThumbnailId);
