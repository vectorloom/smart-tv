using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace SmartTv;

public sealed record StoredSettings(int Format, Guid Revision, Guid ProtectionGeneration, string BaseUrl, Guid[] AlbumIds, string? ProtectedKey);
public sealed record SettingsView(string Revision, string Source, string BaseUrl, Guid[] AlbumIds, bool KeyConfigured, string? MaskedKey);

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
    private readonly Dictionary<(Guid, bool), IDataProtector> protectors = [];
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
    private IDataProtector Protector(Guid generation, bool create)
    {
        lock (gate)
        {
            if (protectors.TryGetValue((generation, create), out var cached)) return cached;
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
            var protector = DataProtectionProvider.Create(new DirectoryInfo(folder), options => {
                options.SetApplicationName("smart-tv-settings-v1").ProtectKeysWithCertificate(certificate);
                if (!create) options.DisableAutomaticKeyGeneration();
            }).CreateProtector("Immich.ApiKey.v1");
            protectors[(generation, create)] = protector;
            return protector;
        }
    }

    private static DashboardException Unavailable() => new(503, "Stored settings are unavailable. Use the documented administrator recovery procedure; environment fallback is disabled while stored settings exist.");
    // Short values have no visible characters: prefix/suffix would disclose the key.
    public static string? MaskKey(string? key) => string.IsNullOrWhiteSpace(key) ? null
        : key.Length <= 8 ? new string('•', 8)
        : key[..4] + new string('•', key.Length - 8) + key[^4..];

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
    // Offline, explicit CLI recovery. It deliberately never decrypts the lost key.
    public void RecoverWrappingKey()
    {
        if (!writable) throw new InvalidOperationException();
        lock (gate)
        {
            var doc = Read() ?? throw new DashboardException(400, "No persisted settings to recover.");
            // Verify new wrapping material can actually protect and unprotect first.
            var generation = Guid.NewGuid();
            var protector = Protector(generation, true);
            if (protector.Unprotect(protector.Protect("recovery-check")) != "recovery-check") throw new CryptographicException();
            PrivateFiles.Json(PathName, doc with { Revision = Guid.NewGuid(), ProtectionGeneration = generation, ProtectedKey = null });
        }
    }
}
