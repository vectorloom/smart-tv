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
    public void PairedSessionsSurviveTvOfflineAndRenewOnReconnect()
    {
        using var service = new RemoteControl(clock);
        var a = Register(service);
        var phone = new RemotePeer("phone");
        Send(service, phone, new { type = "pair", code = a.Code });
        var phoneToken = Last(phone, "ready").GetProperty("credential").GetString();
        // TV is switched off overnight and the phone sleeps: both reconnect with stored credentials.
        service.Disconnect(a.Tv); service.Disconnect(phone);
        clock.Now = clock.Now.AddDays(1); service.Tick();
        var tv = new RemotePeer("tv"); Send(service, tv, new { type = "resume", credential = a.Token });
        Assert.False(Last(tv, "ready").GetProperty("connected").GetBoolean());
        var phone2 = new RemotePeer("phone"); Send(service, phone2, new { type = "resume", credential = phoneToken });
        Last(phone2, "ready");
        Read(tv); Send(service, phone2, new { type = "command", command = "Up" });
        Assert.Equal("Up", Last(tv, "command").GetProperty("command").GetString());
        // The lifetime slides from the last reconnect, then expires after 30 idle days.
        clock.Now = clock.Now.AddDays(29); service.Tick(); Assert.DoesNotContain(Read(tv), m => m.GetProperty("type").GetString() == "expired");
        clock.Now = clock.Now.AddDays(2); service.Tick(); Last(tv, "expired");
    }
    [Fact]
    public void TvTakeoverTellsThePreviousTabInsteadOfFlapping()
    {
        using var service = new RemoteControl(clock);
        var a = Register(service);
        Read(a.Tv);
        var second = new RemotePeer("tv"); Send(service, second, new { type = "resume", credential = a.Token });
        Last(second, "ready");
        Assert.Equal("replaced", Assert.Single(Read(a.Tv)).GetProperty("type").GetString());
        // The replaced peer's outbox is completed, and its later disconnect leaves the session online.
        Assert.False(a.Tv.Outbox.Writer.TryWrite(new { type = "late" }));
        service.Disconnect(a.Tv);
        var phone = new RemotePeer("phone");
        Send(service, second, new { type = "code" });
        Send(service, phone, new { type = "pair", code = Last(second, "code").GetProperty("code").GetString() });
        Assert.True(Last(phone, "ready").GetProperty("connected").GetBoolean());
    }
    [Fact]
    public void PairedSessionsSurviveRestartAndTheFileHoldsOnlyHashes()
    {
        var file = Path.Combine(Path.GetTempPath(), $"remote-{Guid.NewGuid():N}.json");
        try
        {
            string tvToken, phoneToken;
            using (var service = new RemoteControl(clock, file, null))
            {
                var a = Register(service); tvToken = a.Token;
                var phone = new RemotePeer("phone");
                Send(service, phone, new { type = "pair", code = a.Code });
                phoneToken = Last(phone, "ready").GetProperty("credential").GetString()!;
                // An unpaired TV session is not persisted.
                Register(service, "tv2");
            }
            var json = File.ReadAllText(file);
            Assert.DoesNotContain(tvToken, json);
            Assert.DoesNotContain(phoneToken, json);
            using var stored = JsonDocument.Parse(json);
            Assert.Single(stored.RootElement.GetProperty("sessions").EnumerateArray());
            if (!OperatingSystem.IsWindows()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(file));

            // A restart (or redeploy) a day later: both ends resume and commands flow again.
            clock.Now = clock.Now.AddDays(1);
            using (var restarted = new RemoteControl(clock, file, null))
            {
                var tv = new RemotePeer("tv"); Send(restarted, tv, new { type = "resume", credential = tvToken });
                Assert.Equal(tvToken, Last(tv, "ready").GetProperty("credential").GetString());
                var phone = new RemotePeer("phone"); Send(restarted, phone, new { type = "resume", credential = phoneToken });
                Last(phone, "ready");
                Read(tv); Send(restarted, phone, new { type = "command", command = "Select" });
                Assert.Equal("Select", Last(tv, "command").GetProperty("command").GetString());
            }
            // The expiry slid to 30 days after that reconnect; 31 idle days later the session is gone.
            clock.Now = clock.Now.AddDays(29);
            using (var later = new RemoteControl(clock, file, null))
            { var tv = new RemotePeer("tv"); Send(later, tv, new { type = "resume", credential = tvToken }); Last(tv, "ready"); }
            clock.Now = clock.Now.AddDays(31);
            using (var expired = new RemoteControl(clock, file, null))
            { var tv = new RemotePeer("tv"); Send(expired, tv, new { type = "resume", credential = tvToken }); Last(tv, "denied"); }
        }
        finally { File.Delete(file); }
    }
    [Fact]
    public void UnpairAndForgetRemoveTheStoredSession()
    {
        var file = Path.Combine(Path.GetTempPath(), $"remote-{Guid.NewGuid():N}.json");
        try
        {
            using var service = new RemoteControl(clock, file, null);
            var a = Register(service); var phone = new RemotePeer("phone");
            Send(service, phone, new { type = "pair", code = a.Code }); Last(phone, "ready");
            Send(service, a.Tv, new { type = "unpair" }); Last(phone, "revoked");
            Assert.Empty(JsonDocument.Parse(File.ReadAllText(file)).RootElement.GetProperty("sessions").EnumerateArray());

            // "Unpair this TV" ends the TV session itself; its old credential no longer resumes.
            var b = Register(service, "tv2"); var phone2 = new RemotePeer("phone2");
            Send(service, phone2, new { type = "pair", code = b.Code }); Last(phone2, "ready");
            Send(service, b.Tv, new { type = "forget" });
            Last(b.Tv, "forgotten"); Last(phone2, "revoked");
            Assert.Empty(JsonDocument.Parse(File.ReadAllText(file)).RootElement.GetProperty("sessions").EnumerateArray());
            var again = new RemotePeer("tv2"); Send(service, again, new { type = "resume", credential = b.Token }); Last(again, "denied");
            // The same socket may register a fresh session.
            Send(service, b.Tv, new { type = "register" }); Last(b.Tv, "ready");
        }
        finally { File.Delete(file); }
    }
    [Fact]
    public void UnreadableSessionFileStartsEmpty()
    {
        var file = Path.Combine(Path.GetTempPath(), $"remote-{Guid.NewGuid():N}.json");
        try
        {
            File.WriteAllText(file, "{ not json");
            using var service = new RemoteControl(clock, file, null);
            var tv = new RemotePeer("tv"); Send(service, tv, new { type = "resume", credential = new string('A', 64) }); Last(tv, "denied");
            Register(service);
        }
        finally { File.Delete(file); }
    }
    [Fact]
    public void UserAgentIsLoggedSafely()
    {
        var context = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        Assert.Equal("(none)", RemoteControl.UserAgent(context));
        context.Request.Headers.UserAgent = "Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) Chrome/120\r\nFAKE log line";
        Assert.Equal("Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) Chrome/120??FAKE log line", RemoteControl.UserAgent(context));
        context.Request.Headers.UserAgent = "Agent\u0007" + new string('x', 400);
        var cleaned = RemoteControl.UserAgent(context);
        Assert.StartsWith("Agent?", cleaned);
        Assert.Equal(257, cleaned.Length);
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
