using System.Net;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace SmartTv.Tests;

public sealed class WeatherForecastTests
{
    private const string Payload = """
        {
          "current":{"time":"2026-09-26T09:00","temperature_2m":81.4,"weather_code":2,"is_day":1},
          "hourly":{
            "time":["2026-09-26T09:00","2026-09-26T10:00","2026-09-26T11:00","2026-09-26T12:00","2026-09-26T13:00","2026-09-26T14:00","2026-09-26T15:00","2026-09-26T16:00","2026-09-26T17:00","2026-09-26T18:00","2026-09-26T19:00","2026-09-26T20:00","2026-09-26T21:00"],
            "temperature_2m":[81.4,82,83,84,85,86,87,86,84,82,80,78,76],
            "weather_code":[2,2,1,0,0,1,2,3,3,2,1,0,0],
            "precipitation_probability":[10,10,0,0,0,5,10,20,20,10,0,0,0]
          },
          "daily":{
            "time":["2026-09-26","2026-09-27","2026-09-28","2026-09-29","2026-09-30","2026-10-01","2026-10-02"],
            "temperature_2m_max":[87,86,84,82,80,81,83],
            "temperature_2m_min":[70,69,68,67,66,67,68],
            "weather_code":[2,3,61,0,1,95,2],
            "precipitation_probability_max":[20,40,80,0,10,60,15]
          }
        }
        """;

    [Fact]
    public async Task MapsCurrentHourlyAndSevenDayForecast()
    {
        var (service, handler, _) = Create(_ => Response(HttpStatusCode.OK, Payload));
        var result = await service.GetForecast(CancellationToken.None);

        Assert.Equal("Dallas–Fort Worth", result.Location);
        Assert.Equal(81.4, result.Current.TemperatureF);
        Assert.Equal("Partly cloudy", result.Current.Condition);
        Assert.Equal(10, result.Current.PrecipitationProbability);
        Assert.True(result.Current.IsDay);
        Assert.Equal(12, result.Hourly.Length);
        Assert.Equal("09:00", result.Hourly[0].Time[^5..]);
        Assert.Equal(20, result.Hourly[7].PrecipitationProbability);
        Assert.Equal(7, result.Daily.Length);
        Assert.Equal(87, result.Daily[0].HighF);
        Assert.Equal(70, result.Daily[0].LowF);
        Assert.Equal("Light rain", result.Daily[2].Condition);
        Assert.Equal(80, result.Daily[2].PrecipitationProbability);
        Assert.False(result.Stale);
        Assert.Contains("temperature_unit=fahrenheit", handler.LastRequest!.Query);
        Assert.Contains("timezone=America%2FChicago", handler.LastRequest.Query);
        Assert.Contains("forecast_days=7", handler.LastRequest.Query);
    }

    [Fact]
    public async Task UsesCacheAndReturnsStaleForecastAfterProviderFailure()
    {
        var requests = 0;
        var (service, _, clock) = Create(_ => ++requests == 1
            ? Response(HttpStatusCode.OK, Payload)
            : Response(HttpStatusCode.BadGateway, "{}"));

        var initial = await service.GetForecast(CancellationToken.None);
        var cached = await service.GetForecast(CancellationToken.None);
        Assert.Equal(1, requests);
        Assert.False(cached.Stale);

        clock.Advance(TimeSpan.FromMinutes(21));
        var stale = await service.GetForecast(CancellationToken.None);
        Assert.Equal(2, requests);
        Assert.True(stale.Stale);
        Assert.Equal(initial.LastUpdated, stale.LastUpdated);

        var cooldown = await service.GetForecast(CancellationToken.None);
        Assert.Equal(2, requests);
        Assert.True(cooldown.Stale);
    }

    [Fact]
    public async Task ReportsRecoverableUnavailableResponseWithoutCachedForecast()
    {
        var (service, _, _) = Create(_ => Response(HttpStatusCode.ServiceUnavailable, "{}"));
        var error = await Assert.ThrowsAsync<DashboardException>(() => service.GetForecast(CancellationToken.None));
        Assert.Equal(503, error.Status);
        Assert.Contains("temporarily unavailable", error.Message);
    }

    [Fact]
    public void ReadsAndValidatesEnvironmentCoordinates()
    {
        var defaults = WeatherOptions.FromConfiguration(new ConfigurationBuilder().Build());
        Assert.Equal(32.7767, defaults.Latitude);
        Assert.Equal(-96.7970, defaults.Longitude);
        var configured = WeatherOptions.FromConfiguration(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["Weather:Latitude"] = "32.9", ["Weather:Longitude"] = "-97.1" }).Build());
        Assert.Equal(32.9, configured.Latitude);
        Assert.Equal(-97.1, configured.Longitude);
        Assert.True(double.IsNaN(WeatherOptions.FromConfiguration(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["Weather:Latitude"] = "north" }).Build()).Latitude));
    }

    private static HttpResponseMessage Response(HttpStatusCode status, string content) => new(status) { Content = new StringContent(content) };

    private static (WeatherForecastService Service, StubHandler Handler, TestClock Clock) Create(Func<HttpRequestMessage, HttpResponseMessage> response)
    {
        var handler = new StubHandler(response);
        var clock = new TestClock();
        var client = new HttpClient(handler);
        return (new WeatherForecastService(client, new WeatherOptions(32.7767, -96.7970), clock), handler, clock);
    }

    private sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> response) : HttpMessageHandler
    {
        public Uri? LastRequest { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request.RequestUri;
            return Task.FromResult(response(request));
        }
    }

    private sealed class TestClock : TimeProvider
    {
        private DateTimeOffset now = new(2026, 9, 26, 14, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan amount) => now += amount;
    }
}
