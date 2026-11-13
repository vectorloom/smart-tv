using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace SmartTv;

public sealed record StoredSettings(int Format, Guid Revision, Guid ProtectionGeneration, string BaseUrl, Guid[] AlbumIds, string? ProtectedKey);
public sealed record SettingsView(string Revision, string Source, string BaseUrl, Guid[] AlbumIds, bool KeyConfigured, string? MaskedKey);
public sealed record StoredHomeAssistant(int Format, Guid Revision, Guid ProtectionGeneration, string BaseUrl, string[] EntityIds, string? ProtectedToken);
/// <summary>What the administrator page may see: never the token, only whether one is saved and its masked form.</summary>
public sealed record HomeAssistantView(string Revision, bool Configured, string BaseUrl, string[] EntityIds, bool TokenConfigured, string? MaskedToken);

public static class PrivateFiles
{
    public static void DirectoryFor(string path)
    {
        Directory.CreateDirectory(path);
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Storage directory must not be a symlink.");
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }
    public static void Write(string path, byte[] bytes)
    {
        DirectoryFor(Path.GetDirectoryName(path)!);
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            using (var file = new FileStream(temp, options)) { file.Write(bytes); file.Flush(true); }
            File.Move(temp, path, true);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    public static T? Read<T>(string path)
    {
        try
        {
            // File.Exists returns false for some permission errors. Only a genuine
            // missing file may trigger environment fallback, never an unreadable store.
            using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0 || file.Length > 1024 * 1024) throw new IOException("Invalid settings file.");
            return JsonSerializer.Deserialize<T>(file) ?? throw new JsonException();
        }
        catch (FileNotFoundException) { return default; }
    }

    public static void Json<T>(string path, T value) => Write(path, JsonSerializer.SerializeToUtf8Bytes(value));
}

// Each request reads one complete, atomically replaced revision. The public process
// never writes. No partially updated key/URL/selection can become active.
public sealed class SettingsStore(string? directory, ImmichSettings environment, string? certificatePath, string? keyPath, bool writable)
{
    private readonly object gate = new();
    private X509Certificate2? wrappingCertificate;
    private readonly Dictionary<(Guid, bool), IDataProtectionProvider> providers = [];
    private const string ImmichPurpose = "Immich.ApiKey.v1";
    // A separate purpose: an Immich ciphertext can never be unprotected as a Home Assistant token, or vice versa.
    private const string HomeAssistantPurpose = "HomeAssistant.Token.v1";
    public ImmichSettings EnvironmentSettings => environment;
    public string? DirectoryPath => directory;
    private string PathName => Path.Combine(directory ?? throw new DashboardException(503, "Persistent settings are not enabled."), "settings.json");
    private StoredSettings? Read()
    {
        if (directory == null) return null;
        var doc = PrivateFiles.Read<StoredSettings>(PathName);
        if (doc != null && (doc.Format != 1 || doc.Revision == Guid.Empty || doc.ProtectionGeneration == Guid.Empty || doc.AlbumIds == null || doc.AlbumIds.Length > 1000 || !Uri.TryCreate(doc.BaseUrl, UriKind.Absolute, out _)))
            throw new JsonException();
        return doc;
    }
    private IDataProtector Protector(Guid generation, bool create, string purpose = ImmichPurpose)
    {
        lock (gate)
        {
            if (providers.TryGetValue((generation, create), out var cached)) return cached.CreateProtector(purpose);
            if (certificatePath == null || keyPath == null) throw new CryptographicException();
            var certificate = wrappingCertificate ??= X509Certificate2.CreateFromPemFile(certificatePath, keyPath);
            var folder = Path.Combine(directory!, "keyring", generation.ToString("N"));
            if (create)
            {
                PrivateFiles.DirectoryFor(directory!);
                PrivateFiles.DirectoryFor(Path.Combine(directory!, "keyring"));
                PrivateFiles.DirectoryFor(folder);
            }
            if (!Directory.Exists(folder)) throw new CryptographicException();
            var provider = DataProtectionProvider.Create(new DirectoryInfo(folder), options => {
                options.SetApplicationName("smart-tv-settings-v1").ProtectKeysWithCertificate(certificate);
                if (!create) options.DisableAutomaticKeyGeneration();
            });
            providers[(generation, create)] = provider;
            return provider.CreateProtector(purpose);
        }
    }

    private static DashboardException Unavailable() => new(503, "Stored settings are unavailable. Use the documented administrator recovery procedure; environment fallback is disabled while stored settings exist.");
    // Short values have no visible characters: prefix/suffix would disclose the key. The dots are capped
    // so a long credential (a ~180-character Home Assistant token) stays a short identifier, not a page-wide line.
    public const int MaxMaskDots = 16;
    public static string? MaskKey(string? key) => string.IsNullOrWhiteSpace(key) ? null
        : key.Length <= 8 ? new string('•', 8)
        : key[..4] + new string('•', Math.Min(key.Length - 8, MaxMaskDots)) + key[^4..];

    private string? MaskStoredKey(StoredSettings doc)
    {
        if (doc.ProtectedKey == null) return null;
        try { return MaskKey(Protector(doc.ProtectionGeneration, false).Unprotect(doc.ProtectedKey)); }
        // Keep metadata and replacement available when wrapping material is lost.
        catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException or FormatException) { return null; }
    }
    public SettingsView View()
    {
        try
        {
            var doc = Read();
            return doc == null
                ? new("environment", "environment", environment.BaseUrl.AbsoluteUri, environment.AlbumIds.ToArray(), !string.IsNullOrWhiteSpace(environment.ApiKey), MaskKey(environment.ApiKey))
                : new(doc.Revision.ToString(), "persisted", doc.BaseUrl, doc.AlbumIds, doc.ProtectedKey != null, MaskStoredKey(doc));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { throw Unavailable(); }
    }
    public ImmichSettings Snapshot()
    {
        try
        {
            var doc = Read();
            if (doc == null) return environment;
            var key = doc.ProtectedKey == null ? "" : Protector(doc.ProtectionGeneration, false).Unprotect(doc.ProtectedKey);
            return new(new Uri(doc.BaseUrl), key, doc.AlbumIds.ToHashSet());
        }
        catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException or JsonException or FormatException) { throw Unavailable(); }
    }
    public SettingsView Commit(ImmichSettings candidate, string expectedRevision)
    {
        lock (gate)
        {
            if (!writable) throw new DashboardException(403, "Settings storage is read-only.");
            // Validation runs first; revision check under the write lock prevents a
            // slow candidate validation from overwriting a newer successful save.
            var current = View();
            if (current.Revision != expectedRevision) throw new DashboardException(409, "Settings changed. Reload before saving.");
            var previous = Read();
            var generation = previous?.ProtectionGeneration ?? Guid.NewGuid();
            try
            {
                var protectedKey = string.IsNullOrEmpty(candidate.ApiKey) ? null : Protector(generation, true).Protect(candidate.ApiKey);
                var ring = Path.Combine(directory!, "keyring", generation.ToString("N"));
                if (!OperatingSystem.IsWindows() && Directory.Exists(ring))
                    foreach (var file in Directory.GetFiles(ring)) File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                PrivateFiles.Json(PathName, new StoredSettings(1, Guid.NewGuid(), generation, candidate.BaseUrl.AbsoluteUri, candidate.AlbumIds.ToArray(), protectedKey));
                return View();
            }
            catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException) { throw new DashboardException(503, "Could not securely persist settings. The previous configuration was retained."); }
        }
    }
    // Offline, explicit CLI recovery. It deliberately never decrypts the lost key or token: both are
    // cleared and must be entered again; URLs, album and entity selections are kept.
    public void RecoverWrappingKey()
    {
        if (!writable) throw new InvalidOperationException();
        lock (gate)
        {
            var doc = Read();
            var assistant = ReadHomeAssistant();
            if (doc == null && assistant == null) throw new DashboardException(400, "No persisted settings to recover.");
            // Verify new wrapping material can actually protect and unprotect first.
            var generation = Guid.NewGuid();
            var protector = Protector(generation, true);
            if (protector.Unprotect(protector.Protect("recovery-check")) != "recovery-check") throw new CryptographicException();
            if (doc != null) PrivateFiles.Json(PathName, doc with { Revision = Guid.NewGuid(), ProtectionGeneration = generation, ProtectedKey = null });
            if (assistant != null) PrivateFiles.Json(HomeAssistantPath, assistant with { Revision = Guid.NewGuid(), ProtectionGeneration = generation, ProtectedToken = null });
        }
    }

    // ---- Home Assistant: its own atomically replaced document and revision, same wrapping material.
    // There is no environment fallback: the token can only be entered on the administrator page.
    public const int MaxEntities = 200;
    private string HomeAssistantPath => Path.Combine(directory ?? throw new DashboardException(503, "Persistent settings are not enabled."), "home-assistant.json");
    private StoredHomeAssistant? ReadHomeAssistant()
    {
        if (directory == null) return null;
        var doc = PrivateFiles.Read<StoredHomeAssistant>(HomeAssistantPath);
        if (doc != null && (doc.Format != 1 || doc.Revision == Guid.Empty || doc.ProtectionGeneration == Guid.Empty || doc.EntityIds == null ||
            doc.EntityIds.Length > MaxEntities || !doc.EntityIds.All(HomeAssistantSettings.IsEntityId) || !Uri.TryCreate(doc.BaseUrl, UriKind.Absolute, out _)))
            throw new JsonException();
        return doc;
    }
    private static DashboardException HomeAssistantUnavailable() => new(503, "Stored Home Assistant settings are unavailable. Use the documented administrator recovery procedure.");
    public HomeAssistantView HomeAssistantView()
    {
        try
        {
            var doc = ReadHomeAssistant();
            if (doc == null) return new("none", false, "", [], false, null);
            string? masked = null;
            if (doc.ProtectedToken != null)
                try { masked = MaskKey(Protector(doc.ProtectionGeneration, false, HomeAssistantPurpose).Unprotect(doc.ProtectedToken)); }
                catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException or FormatException) { }
            return new(doc.Revision.ToString(), true, doc.BaseUrl, doc.EntityIds, doc.ProtectedToken != null, masked);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { throw HomeAssistantUnavailable(); }
    }
    /// <summary>The revision alone, without decrypting anything: the TV process polls it to notice a save.</summary>
    public string HomeAssistantRevision()
    {
        try { return ReadHomeAssistant()?.Revision.ToString() ?? "none"; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { throw HomeAssistantUnavailable(); }
    }
    /// <summary>Null when Home Assistant has never been configured.</summary>
    public HomeAssistantSettings? HomeAssistantSnapshot()
    {
        try
        {
            var doc = ReadHomeAssistant();
            if (doc == null) return null;
            var token = doc.ProtectedToken == null ? "" : Protector(doc.ProtectionGeneration, false, HomeAssistantPurpose).Unprotect(doc.ProtectedToken);
            return new(new Uri(doc.BaseUrl), token, doc.EntityIds, doc.Revision.ToString());
        }
        catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException or JsonException or FormatException) { throw HomeAssistantUnavailable(); }
    }
    public HomeAssistantView CommitHomeAssistant(HomeAssistantSettings candidate, string expectedRevision)
    {
        lock (gate)
        {
            if (!writable) throw new DashboardException(403, "Settings storage is read-only.");
            if (HomeAssistantView().Revision != expectedRevision) throw new DashboardException(409, "Settings changed. Reload before saving.");
            var generation = ReadHomeAssistant()?.ProtectionGeneration ?? Guid.NewGuid();
            try
            {
                var protectedToken = string.IsNullOrEmpty(candidate.Token) ? null : Protector(generation, true, HomeAssistantPurpose).Protect(candidate.Token);
                var ring = Path.Combine(directory!, "keyring", generation.ToString("N"));
                if (!OperatingSystem.IsWindows() && Directory.Exists(ring))
                    foreach (var file in Directory.GetFiles(ring)) File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                PrivateFiles.Json(HomeAssistantPath, new StoredHomeAssistant(1, Guid.NewGuid(), generation, candidate.BaseUrl.AbsoluteUri, candidate.EntityIds, protectedToken));
                return HomeAssistantView();
            }
            catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException) { throw new DashboardException(503, "Could not securely persist settings. The previous configuration was retained."); }
        }
    }
}
