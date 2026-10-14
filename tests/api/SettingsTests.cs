using Microsoft.Extensions.Configuration;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using SmartTv;
using Xunit;

// Failure output must not print even synthetic key material.
#pragma warning disable xUnit2009

public sealed class SettingsMaterial : IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "smart-tv-settings-tests-" + Guid.NewGuid().ToString("N"));
    public string Material => Path.Combine(Root, "material");
    public SettingsMaterial() { Provisioning.Material(Material); }
    public string State() { var path = Path.Combine(Root, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(path); return path; }
    public SettingsStore Store(string path, ImmichSettings? environment = null, bool writable = true, string? material = null) => new(path,
        environment ?? new(new Uri("http://immich.test:2283/api/"), "synthetic-read-key", [SettingsTests.Owned]),
        Path.Combine(material ?? Material, "wrapping.crt"), Path.Combine(material ?? Material, "wrapping.key"), writable);
    public void Dispose() => Directory.Delete(Root, true);
}

public class SettingsTests(SettingsMaterial material) : IClassFixture<SettingsMaterial>
{
    public static readonly Guid Owned = Guid.Parse("11111111-1111-4111-8111-111111111111");
    public static readonly Guid Shared = Guid.Parse("33333333-3333-4333-8333-333333333333");
    public static readonly Guid Asset = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static readonly ConnectionTargets Targets = new(["http://immich.test:2283/api/"], ["127.0.0.1"]);
    public sealed class ImmichStub : HttpMessageHandler, IHttpClientFactory
    {
        public bool RejectKey; public bool RejectThumbnail; public bool Empty; public bool Unsupported;
        public bool RejectShared; public int Calls;
        public HttpClient CreateClient(string name) => new(this, false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            if (RejectKey) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized));
            var path = request.RequestUri!.AbsolutePath;
            object value;
            if (path.EndsWith("server/version")) value = new { major = Unsupported ? 4 : 3, minor = 1, patch = 0 };
            else if (path.EndsWith("/albums")) value = request.RequestUri.Query.Contains("isShared")
                ? RejectShared ? Array.Empty<object>() : new object[] { new { id = Shared, albumName = "Shared memories", assetCount = Empty ? 0 : 1, albumThumbnailAssetId = Asset } }
                : new object[] { new { id = Owned, albumName = "Owned memories", assetCount = Empty ? 0 : 1, albumThumbnailAssetId = Asset } };
            else if (path.EndsWith("search/metadata")) value = new { assets = new { items = Empty ? Array.Empty<object>() : new object[] { new { id = Asset, originalFileName = "Synthetic photo", type = "IMAGE", isTrashed = false } }, nextPage = (string?)null } };
            else if (path.EndsWith("/thumbnail"))
            {
                if (RejectThumbnail) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([1, 2, 3]) }; response.Content.Headers.ContentType = new("image/jpeg");
                return Task.FromResult(response);
            }
            else return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(value) });
        }
    }
    [Fact]
    public void MaskingHandlesMissingShortAndNormalKeysWithoutDisclosingCompleteValues()
    {
        Assert.Null(SettingsStore.MaskKey(null));
        Assert.Null(SettingsStore.MaskKey(""));
        Assert.Null(SettingsStore.MaskKey("   "));
        for (var length = 1; length <= 32; length++)
        {
            var key = new string('a', length);
            var masked = SettingsStore.MaskKey(key)!;
            Assert.False(masked.Contains(key));
            Assert.True(masked == (length <= 8 ? new string('•', 8) : "aaaa" + new string('•', length - 8) + "aaaa"));
        }
    }
    [Fact]
    public void EncryptedRoundTripAndRestartRetainSettingsWithoutPlaintextSecrets()
    {
        var path = material.State(); var store = material.Store(path);
        var settings = new ImmichSettings(new Uri("http://immich.test:2283/api/"), "synthetic-replacement-key", [Shared]);
        store.Commit(settings, "environment");
        var fresh = material.Store(path, writable: false);
        Assert.True(fresh.Snapshot().ApiKey == settings.ApiKey);
        Assert.Equal(new[] { Shared }, fresh.Snapshot().AlbumIds);
        Assert.True(fresh.View().MaskedKey == SettingsStore.MaskKey(settings.ApiKey));
        Assert.True(fresh.View().KeyConfigured); Assert.Equal("persisted", fresh.View().Source);
        var serialized = File.ReadAllText(Path.Combine(path, "settings.json"));
        Assert.False(serialized.Contains(settings.ApiKey));
        Assert.False(JsonSerializer.Serialize(fresh.View()).Contains(settings.ApiKey));
        foreach (var file in Directory.GetFiles(Path.Combine(path, "keyring"), "*.xml", SearchOption.AllDirectories))
        {
            Assert.Contains("encryptedSecret", File.ReadAllText(file));
            if (!OperatingSystem.IsWindows()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(file));
        }
    }
    [Fact]
    public void BackupRestoresInANewDirectoryWithOriginalWrappingMaterial()
    {
        var path = material.State(); var original = material.Store(path);
        original.Commit(original.Snapshot() with { AlbumIds = [Shared] }, "environment");
        var restoredPath = material.State();
        foreach (var file in Directory.GetFiles(path, "*", SearchOption.AllDirectories))
        {
            var destination = Path.Combine(restoredPath, Path.GetRelativePath(path, file));
            PrivateFiles.Write(destination, File.ReadAllBytes(file));
        }
        var restored = material.Store(restoredPath, writable: false);
        Assert.True(restored.Snapshot().ApiKey == original.Snapshot().ApiKey);
        Assert.Equal(new[] { Shared }, restored.Snapshot().AlbumIds);
    }
    [Fact]
    public void ExistingReaderObservesAtomicSelectionChangesWithoutRestart()
    {
        var path = material.State(); var writer = material.Store(path); var reader = material.Store(path, writable: false);
        var first = writer.Commit(writer.Snapshot(), "environment");
        writer.Commit(writer.Snapshot() with { AlbumIds = [Shared] }, first.Revision);
        Assert.Equal(new[] { Shared }, reader.Snapshot().AlbumIds);
        Assert.Equal(403, Assert.Throws<DashboardException>(() => reader.Commit(reader.Snapshot(), reader.View().Revision)).Status);
    }
    [Fact]
    public void PersistedSettingsOverrideMissingEmptyOrDifferentLegacyAlbumSelections()
    {
        var path = material.State();
        var writer = material.Store(path);
        var saved = writer.Snapshot() with { AlbumIds = [Shared] };
        writer.Commit(saved, "environment");
        foreach (var fallback in new string?[] { null, "", Owned.ToString() })
        {
            var config = new Microsoft.Extensions.Configuration.ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?> {
                    ["Immich:BaseUrl"] = "http://immich.test:2283/api/",
                    ["Immich:AlbumIds"] = fallback,
                    ["Immich:ApiKey"] = ""
                }).Build();
            var environment = ImmichSettings.FromConfiguration(config);
            var reader = material.Store(path, environment, writable: false);
            Assert.Equal("persisted", reader.View().Source);
            Assert.True(reader.Snapshot().ApiKey == saved.ApiKey);
            Assert.True(reader.Snapshot().AlbumIds.SetEquals(saved.AlbumIds));
        }
    }
    [Fact]
    public void PersistedPrecedenceCorruptionAndStaleRevisionsFailClosed()
    {
        var path = material.State(); var store = material.Store(path);
        store.Commit(store.Snapshot(), "environment");
        Assert.Equal(409, Assert.Throws<DashboardException>(() => store.Commit(store.Snapshot(), "environment")).Status);
        var changedEnvironment = new ImmichSettings(new Uri("http://immich.test:2283/api/"), "synthetic-different-environment", []);
        Assert.True(material.Store(path, changedEnvironment).Snapshot().ApiKey != changedEnvironment.ApiKey);
        File.WriteAllText(Path.Combine(path, "settings.json"), "{}");
        Assert.Equal(503, Assert.Throws<DashboardException>(() => store.Snapshot()).Status);
    }
    [Fact]
    public void UnavailableOrUnreadableStoreNeverFallsBackToEnvironment()
    {
        var absentDirectory = Path.Combine(material.Root, Guid.NewGuid().ToString("N"));
        Assert.Equal(503, Assert.Throws<DashboardException>(() => material.Store(absentDirectory).Snapshot()).Status);
        if (OperatingSystem.IsWindows() || Environment.UserName == "root") return;
        var path = material.State(); var store = material.Store(path); store.Commit(store.Snapshot(), "environment");
        File.SetUnixFileMode(path, UnixFileMode.None);
        try { Assert.Equal(503, Assert.Throws<DashboardException>(() => store.Snapshot()).Status); }
        finally { File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute); }
    }
    [Fact]
    public void LostWrappingRecoveryPreservesSelectionsAndAllowsNewKeyAfterRestart()
    {
        var path = material.State(); var original = material.Store(path);
        original.Commit(original.Snapshot() with { AlbumIds = [Shared] }, "environment");
        var newMaterial = Path.Combine(material.Root, Guid.NewGuid().ToString("N")); Provisioning.Material(newMaterial);
        var recovery = material.Store(path, material: newMaterial);
        Assert.Equal(503, Assert.Throws<DashboardException>(() => recovery.Snapshot()).Status);
        Assert.Null(recovery.View().MaskedKey);
        recovery.RecoverWrappingKey();
        Assert.Null(recovery.View().MaskedKey);
        Assert.False(recovery.View().KeyConfigured); Assert.Equal(new[] { Shared }, recovery.View().AlbumIds);
        Assert.Empty(recovery.Snapshot().ApiKey); // Does not silently fall back to environment key.
        recovery.Commit(recovery.Snapshot() with { ApiKey = "synthetic-restored-key" }, recovery.View().Revision);
        var restarted = material.Store(path, material: newMaterial);
        Assert.True(restarted.Snapshot().ApiKey == "synthetic-restored-key");
        Assert.Equal(new[] { Shared }, restarted.Snapshot().AlbumIds);
    }
    [Fact]
    public void MissingEncryptionMaterialCannotPersistPlaintext()
    {
        var path = material.State(); var store = new SettingsStore(path, material.Store(path).Snapshot(), null, null, true);
        Assert.Throws<DashboardException>(() => store.Commit(store.Snapshot(), "environment"));
        Assert.False(File.Exists(Path.Combine(path, "settings.json")));
    }
    [Fact]
    public async Task SharedAlbumListingAndValidatedSelectionPersist()
    {
        using var stub = new ImmichStub(); var store = material.Store(material.State()); var manager = new SettingsManager(store, Targets, stub);
        Assert.Equal(2, (await manager.Albums(default)).Length);
        var saved = await manager.Save(new("environment", store.View().BaseUrl, null, [Shared]), default);
        Assert.Equal(new[] { Shared }, saved.AlbumIds);
        var client = new ImmichClient(stub.CreateClient(""), store.Snapshot());
        Assert.Equal(Shared, Assert.Single(await client.Albums(default)).Id);
        Assert.NotEmpty((await manager.Thumbnail(Shared, default)).Bytes);
        await Assert.ThrowsAsync<DashboardException>(() => manager.Thumbnail(Guid.NewGuid(), default));
    }
    [Theory]
    [InlineData("key")]
    [InlineData("thumbnail")]
    [InlineData("version")]
    [InlineData("empty")]
    [InlineData("selection")]
    public async Task FailedValidationPreservesPriorWorkingConfiguration(string failure)
    {
        using var stub = new ImmichStub(); var path = material.State(); var store = material.Store(path); var manager = new SettingsManager(store, Targets, stub);
        await manager.Import("environment", default);
        var before = File.ReadAllBytes(Path.Combine(path, "settings.json"));
        var identifier = store.View().MaskedKey;
        stub.RejectKey = failure == "key"; stub.RejectThumbnail = failure == "thumbnail"; stub.Unsupported = failure == "version"; stub.Empty = failure == "empty"; stub.RejectShared = failure == "selection";
        await Assert.ThrowsAsync<DashboardException>(() => manager.Save(new(store.View().Revision, store.View().BaseUrl, "synthetic-new-key", [Shared]), default));
        Assert.True(before.SequenceEqual(File.ReadAllBytes(Path.Combine(path, "settings.json"))));
        Assert.True(store.Snapshot().ApiKey == "synthetic-read-key");
        Assert.True(store.View().MaskedKey == identifier);
    }
    [Fact]
    public async Task ExplicitMigrationAndReplacementDoNotReturnTheKey()
    {
        using var stub = new ImmichStub(); var store = material.Store(material.State()); var manager = new SettingsManager(store, Targets, stub);
        var imported = await manager.Import("environment", default);
        Assert.Equal("persisted", imported.Source);
        var replaced = await manager.Save(new(imported.Revision, imported.BaseUrl, "synthetic-new-key", [Owned, Shared]), default);
        Assert.True(store.Snapshot().ApiKey == "synthetic-new-key");
        Assert.True(replaced.MaskedKey == SettingsStore.MaskKey("synthetic-new-key"));
        Assert.True(replaced.MaskedKey != imported.MaskedKey);
        Assert.False(JsonSerializer.Serialize(replaced).Contains("synthetic-new-key"));
    }
    [Theory]
    [InlineData("http://169.254.169.254/api/")]
    [InlineData("http://immich.test:2283/api/../admin/")]
    [InlineData("http://user:password@immich.test:2283/api/")]
    [InlineData("http://immich.test:2283/api/?url=http://bad/")]
    [InlineData("http://immich.test:2284/api/")]
    [InlineData("file:///api/")]
    public async Task UnapprovedDestinationsCannotSendCandidateCredentials(string url)
    {
        using var stub = new ImmichStub(); var store = material.Store(material.State()); var manager = new SettingsManager(store, Targets, stub);
        await Assert.ThrowsAsync<DashboardException>(() => manager.Save(new("environment", url, "synthetic-key", []), default));
        Assert.Equal(0, stub.Calls);
    }
    [Fact]
    public void UnsafeAddressRangesAreRejectedAndTransportCannotBeSpoofedByHeaders()
    {
        Assert.Throws<InvalidOperationException>(() => new ConnectionTargets(["http://immich.test:2283/api/"], ["169.254.169.254"]));
        var context = new DefaultHttpContext(); context.Connection.LocalIpAddress = IPAddress.Loopback; context.Connection.LocalPort = 8080;
        context.Request.Headers["X-Forwarded-Proto"] = "https"; context.Request.Headers["X-Forwarded-Port"] = "8443"; context.Request.Headers["X-Forwarded-For"] = "127.0.0.1";
        Assert.False(AdministratorEndpoints.IsAdminTransport(context, 8443));
        context.Connection.LocalPort = 8443; context.Request.Scheme = "https";
        Assert.True(AdministratorEndpoints.IsAdminTransport(context, 8443));
        context.Connection.LocalIpAddress = IPAddress.Parse("192.168.1.3"); Assert.False(AdministratorEndpoints.IsAdminTransport(context, 8443));
    }
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }
    [Fact]
    public void AdministratorRecoveryRevokesSessionsWithoutChangingAlbumsOrImmichKey()
    {
        var path = material.State(); var store = material.Store(path); store.Commit(store.Snapshot(), "environment");
        var before = File.ReadAllBytes(Path.Combine(path, "settings.json"));
        var clock = new Clock(); var identity = new AdministratorIdentity(path, clock);
        identity.SetPassword("synthetic-old-passphrase", false);
        Assert.Null(identity.Login("synthetic-wrong-passphrase"));
        var user = identity.Login("synthetic-old-passphrase")!; Assert.True(identity.Validate(user));
        // A separate CLI instance updates the stamp. The running service notices it.
        new AdministratorIdentity(path, clock).SetPassword("synthetic-new-passphrase", true);
        Assert.False(identity.Validate(user)); Assert.Null(identity.Login("synthetic-old-passphrase"));
        var recovered = identity.Login("synthetic-new-passphrase")!; Assert.True(identity.Validate(recovered));
        identity.Logout(recovered); Assert.False(identity.Validate(recovered));
        Assert.True(before.SequenceEqual(File.ReadAllBytes(Path.Combine(path, "settings.json"))));
        user = identity.Login("synthetic-new-passphrase")!; clock.Now = clock.Now.AddMinutes(15); Assert.False(identity.Validate(user));
    }
    [Fact]
    public void SessionsHaveAbsoluteExpiryAndRateLimitsReset()
    {
        var clock = new Clock(); var identity = new AdministratorIdentity(material.State(), clock); identity.SetPassword("synthetic-test-passphrase", false);
        var user = identity.Login("synthetic-test-passphrase")!;
        for (var i = 0; i < 47; i++) { clock.Now = clock.Now.AddMinutes(10); Assert.True(identity.Validate(user)); }
        clock.Now = clock.Now.AddMinutes(10); Assert.False(identity.Validate(user));
        var limits = new AdministratorLimits(clock);
        for (var i = 0; i < 5; i++) Assert.True(limits.Allow("login", 5));
        Assert.False(limits.Allow("login", 5)); clock.Now = clock.Now.AddMinutes(1); Assert.True(limits.Allow("login", 5));
    }
}
