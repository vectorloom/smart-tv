using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace SmartTv;

public static class Provisioning
{
    public static void Material(string directory)
    {
        if (Directory.Exists(directory)) throw new IOException("Refusing to overwrite an existing material directory.");
        PrivateFiles.DirectoryFor(directory);
        Certificate(directory, "localhost", true);
        Certificate(directory, "wrapping", false);
    }
    private static void Certificate(string directory, string name, bool tls)
    {
        using var key = RSA.Create(3072);
        var request = new CertificateRequest($"CN={name}", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        if (tls)
        {
            var names = new SubjectAlternativeNameBuilder(); names.AddDnsName("localhost");
            request.CertificateExtensions.Add(names.Build());
            request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, true));
        }
        using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddYears(tls ? 1 : 10));
        PrivateFiles.Write(Path.Combine(directory, name + ".crt"), Encoding.ASCII.GetBytes(certificate.ExportCertificatePem()));
        PrivateFiles.Write(Path.Combine(directory, name + ".key"), Encoding.ASCII.GetBytes(key.ExportPkcs8PrivateKeyPem()));
        if (tls) PrivateFiles.Write(Path.Combine(directory, "localhost.cer"), certificate.Export(X509ContentType.Cert));
    }
    private static string Hidden(string prompt)
    {
        if (Console.IsInputRedirected) throw new InvalidOperationException("Use an interactive terminal; passwords are not accepted as arguments or environment variables.");
        Console.Write(prompt);
        var text = new StringBuilder();
        while (true)
        {
            var key = Console.ReadKey(true);
            if (key.Key == ConsoleKey.Enter) { Console.WriteLine(); return text.ToString(); }
            if (key.Key == ConsoleKey.Backspace && text.Length > 0) text.Length--;
            else if (!char.IsControl(key.KeyChar) && text.Length < 257) text.Append(key.KeyChar);
        }
    }
    public static int Run(string command, IConfiguration config)
    {
        try
        {
            if (command == "provision-material") Material(config["MaterialDirectory"] ?? throw new InvalidOperationException());
            else
            {
                var directory = config["Settings:Directory"] ?? throw new InvalidOperationException();
                if (command is "admin-create" or "admin-reset")
                {
                    var first = Hidden("Administrator passphrase (14–256 characters): ");
                    if (first != Hidden("Repeat passphrase: ")) throw new InvalidOperationException();
                    new AdministratorIdentity(directory, TimeProvider.System).SetPassword(first, command == "admin-reset");
                }
                else if (command == "recover-wrapping")
                {
                    var environment = new ImmichSettings(new Uri("http://127.0.0.1/api/"), "", []);
                    var store = new SettingsStore(directory, environment, config["Settings:WrappingCertificate"], config["Settings:WrappingKey"], true);
                    store.RecoverWrappingKey();
                }
                else throw new InvalidOperationException();
            }
            Console.WriteLine("Operation completed. No credentials were displayed."); return 0;
        }
        catch { Console.Error.WriteLine("Operation failed. Check the documented prerequisites and permissions; existing configuration was not intentionally replaced."); return 1; }
    }
}
