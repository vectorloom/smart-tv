using System.Net;
using System.Net.Sockets;

namespace SmartTv;

// The browser cannot add a target or an approved IP. Deployment owns both lists.
public sealed class ConnectionTargets
{
    public Uri[] Targets { get; }
    private readonly HashSet<IPAddress> addresses;
    public bool HasPinnedAddresses => addresses.Count > 0;
    public ConnectionTargets(IEnumerable<string> targets, IEnumerable<string> approvedAddresses)
    {
        Targets = targets.Select(Parse).Distinct().ToArray();
        addresses = approvedAddresses.Select(IPAddress.Parse).Select(Normalize).ToHashSet();
        if (addresses.Any(Forbidden)) throw new InvalidOperationException("An approved destination address is unsafe.");
    }
    private static IPAddress Normalize(IPAddress address) => address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;
    private static bool Forbidden(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        return address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any) || address.IsIPv6LinkLocal || address.IsIPv6Multicast ||
            (address.AddressFamily == AddressFamily.InterNetwork && (bytes[0] == 0 || bytes[0] >= 224 || (bytes[0] == 169 && bytes[1] == 254)));
    }
    public static Uri Parse(string text)
    {
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") ||
            uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "" || uri.AbsolutePath != "/api/" ||
            text.Contains('%') || text.Contains('\\') || text.Contains("/../") || text.Contains("/./"))
            throw new DashboardException(400, "Choose an approved Immich API destination ending in /api/.");
        return uri;
    }
    public Uri Require(string url)
    {
        var uri = Parse(url);
        if (!Targets.Contains(uri)) throw new DashboardException(400, "Immich destination is not deployment-approved.");
        return uri;
    }
    public async ValueTask<Stream> Connect(SocketsHttpConnectionContext context, CancellationToken ct)
    {
        var endpoint = context.DnsEndPoint;
        if (!Targets.Any(t => t.IdnHost == endpoint.Host && t.Port == endpoint.Port)) throw new HttpRequestException("Destination not approved.");
        var resolved = await Dns.GetHostAddressesAsync(endpoint.Host, ct);
        // No second DNS lookup occurs in Socket.ConnectAsync: the IP itself is used.
        foreach (var address in resolved.Select(Normalize).Distinct())
        {
            if (Forbidden(address) || (HasPinnedAddresses && !addresses.Contains(address))) continue;
            var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
            try { await socket.ConnectAsync(new IPEndPoint(address, endpoint.Port), ct); return new NetworkStream(socket, true); }
            catch (SocketException) { socket.Dispose(); }
            catch { socket.Dispose(); throw; }
        }
        throw new HttpRequestException("No approved Immich address was reachable.");
    }
    public SocketsHttpHandler Handler() => new() {
        AllowAutoRedirect = false, UseCookies = false, UseProxy = false,
        ConnectCallback = Connect, ConnectTimeout = TimeSpan.FromSeconds(5), PooledConnectionLifetime = TimeSpan.FromMinutes(2)
    };
}
