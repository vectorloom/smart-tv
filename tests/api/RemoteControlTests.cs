using System.Text.Json;
using SmartTv;
using Xunit;

public class RemoteControlTests
{
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.Parse("2026-01-01T00:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }
    private readonly Clock clock = new();
    private static void Send(RemoteControl service, RemotePeer peer, object message) => service.Handle(peer, JsonSerializer.Serialize(message));
    private static JsonElement[] Read(RemotePeer peer)
    {
        var messages = new List<JsonElement>();
        while (peer.Outbox.Reader.TryRead(out var value)) messages.Add(JsonSerializer.SerializeToElement(value));
        return messages.ToArray();
    }
    private static JsonElement Last(RemotePeer peer, string type) => Read(peer).Last(m => m.GetProperty("type").GetString() == type);
    private static (RemotePeer Tv, string Token, string Code) Register(RemoteControl service, string ip = "tv")
    {
        var tv = new RemotePeer(ip);
        Send(service, tv, new { type = "register" });
        var token = Last(tv, "ready").GetProperty("credential").GetString()!;
        Send(service, tv, new { type = "code" });
        return (tv, token, Last(tv, "code").GetProperty("code").GetString()!);
    }
    [Fact]
    public void PairingIsSingleUseAndCommandsReachOnlyPairedDashboard()
    {
        using var service = new RemoteControl(clock);
        var a = Register(service); var b = Register(service, "tv2");
        var phone = new RemotePeer("phone");
        Send(service, phone, new { type = "command", command = "Next" });
        Assert.Equal("Pairing required", Last(phone, "error").GetProperty("message").GetString());
        Send(service, phone, new { type = "pair", code = a.Code });
        Assert.Equal(64, Last(phone, "ready").GetProperty("credential").GetString()!.Length);
        Read(a.Tv);
        Send(service, phone, new { type = "command", command = "Next" });
        Assert.Equal("Next", Last(a.Tv, "command").GetProperty("command").GetString());
        Assert.Empty(Read(b.Tv));
        var other = new RemotePeer("other");
        Send(service, other, new { type = "pair", code = a.Code });
        Last(other, "denied");
        Send(service, phone, new { type = "command", command = "DeleteAll" });
        Last(phone, "error"); Assert.Empty(Read(a.Tv));
        Send(service, a.Tv, new { type = "command", command = "Next" }); Last(a.Tv, "error");
    }
    [Fact]
    public void CodesExpireAndRefreshInvalidatesPriorCode()
    {
        using var service = new RemoteControl(clock);
        var a = Register(service);
        Assert.Matches("^[0-9]{8}$", a.Code);
        Send(service, a.Tv, new { type = "code" }); var fresh = Last(a.Tv, "code").GetProperty("code").GetString();
        Assert.NotEqual(a.Code, fresh);
        var phone = new RemotePeer("phone");
        Send(service, phone, new { type = "pair", code = a.Code }); Last(phone, "denied");
        clock.Now = clock.Now.AddMinutes(2);
        Send(service, phone, new { type = "pair", code = fresh }); Last(phone, "denied");
    }
    [Fact]
    public void PairingAttemptsAreLimitedAcrossSocketsAndResetAfterMinute()
    {
        using var service = new RemoteControl(clock);
        for (var i = 0; i < 20; i++)
        {
            var p = new RemotePeer("attacker"); Send(service, p, new { type = "pair", code = "00000000" }); Last(p, "denied");
        }
        var phone = new RemotePeer("attacker");
        Send(service, phone, new { type = "pair", code = "00000000" });
        Assert.Contains("minute", Last(phone, "error").GetProperty("message").GetString());
        clock.Now = clock.Now.AddMinutes(1);
        Send(service, phone, new { type = "pair", code = "00000000" }); Last(phone, "denied");
    }
    [Fact]
    public void ReconnectRestoresScopeWithoutReplayingDisconnectedCommandsAndUnpairRevokes()
    {
        using var service = new RemoteControl(clock);
        var a = Register(service); var phone = new RemotePeer("phone");
        Send(service, phone, new { type = "pair", code = a.Code });
        var token = Last(phone, "ready").GetProperty("credential").GetString(); Read(a.Tv);
        service.Disconnect(a.Tv); Read(phone);
        Send(service, phone, new { type = "command", command = "Next" }); Last(phone, "error");
        var tv = new RemotePeer("tv"); Send(service, tv, new { type = "resume", credential = a.Token });
        Assert.DoesNotContain(Read(tv), m => m.GetProperty("type").GetString() == "command");
        service.Disconnect(phone);
        var resumed = new RemotePeer("phone"); Send(service, resumed, new { type = "resume", credential = token }); Last(resumed, "ready");
        Send(service, resumed, new { type = "command", command = "Home" }); Last(tv, "command");
        Send(service, tv, new { type = "unpair" }); Last(resumed, "revoked");
        var revoked = new RemotePeer("phone"); Send(service, revoked, new { type = "resume", credential = token }); Last(revoked, "denied");
        Send(service, resumed, new { type = "command", command = "Next" }); Last(resumed, "error");
    }
    [Fact]
    public void PhoneCanUnpairAndReplacementRevokesPreviousPhone()
    {
        using var service = new RemoteControl(clock);
        var a = Register(service); var old = new RemotePeer("old");
        Send(service, old, new { type = "pair", code = a.Code }); var token = Last(old, "ready").GetProperty("credential").GetString();
        Send(service, a.Tv, new { type = "code" }); var code = Last(a.Tv, "code").GetProperty("code").GetString();
        var phone = new RemotePeer("new"); Send(service, phone, new { type = "pair", code }); Last(old, "revoked");
        Send(service, new RemotePeer("replay"), new { type = "resume", credential = token });
        Send(service, old, new { type = "command", command = "Next" }); Last(old, "error");
        Send(service, phone, new { type = "unpair" }); Last(phone, "revoked");
    }
    [Fact]
    public void OfflineGraceAndAbsoluteSessionExpirationAreEnforced()
    {
        using var service = new RemoteControl(clock);
        var a = Register(service); service.Disconnect(a.Tv); clock.Now = clock.Now.AddMinutes(2);
        var peer = new RemotePeer("tv"); Send(service, peer, new { type = "resume", credential = a.Token }); Last(peer, "denied");
        var b = Register(service); clock.Now = clock.Now.AddHours(12); service.Tick(); Last(b.Tv, "expired");
        Send(service, b.Tv, new { type = "code" }); Last(b.Tv, "error");
    }
    [Fact]
    public void MalformedMessagesAndFloodingAreBounded()
    {
        using var service = new RemoteControl(clock); var p = new RemotePeer("bad");
        service.Handle(p, "{"); Last(p, "error");
        service.Handle(p, "[]"); Last(p, "error");
        for (var i = 0; i < 40; i++) { Send(service, p, new { type = "ping" }); Read(p); }
        Assert.True(p.Closed.IsCancellationRequested);
        for (var i = 0; i < 60; i++) Assert.True(service.Connect("flood"));
        Assert.False(service.Connect("flood"));
    }
}
