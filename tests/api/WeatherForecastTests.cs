using System.Net;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace SmartTv.Tests;

public sealed class WeatherForecastTests
{
    private const string Payload = """
        {
          "current":{"time":"2026-09-26T09:00","temperature_2m":81.4,"weather_code":2,"is_day":1,"relative_humidity_2m":58,"wind_speed_10m":9.2,"wind_direction_10m":235,"surface_pressure":1008.4},
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
        Assert.Equal(58, result.Current.RelativeHumidity);
        Assert.Equal(9.2, result.Current.WindSpeedMph);
        Assert.Equal(235, result.Current.WindDirectionDegrees);
        Assert.Equal(1008.4, result.Current.PressureHpa);
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
        Assert.Contains("relative_humidity_2m", handler.LastRequest.Query);
        Assert.Contains("wind_speed_unit=mph", handler.LastRequest.Query);
    }

    [Fact]
    public async Task MapsAndCachesRegionalWindGridUsingConfiguredCoordinates()
    {
        var handler = new StubHandler(_ => Response(HttpStatusCode.OK, WindPayload()));
        var service = new WeatherForecastService(new HttpClient(handler),
            new WeatherOptions(32.9579922, -97.0236019, "Coppell"), new TestClock());
        var result = await service.GetRegionalWind(CancellationToken.None);
        var cached = await service.GetRegionalWind(CancellationToken.None);

        Assert.Equal("Coppell", result.Location);
        Assert.Equal("2026-09-26T09:00", result.ValidTime);
        Assert.Equal(25, result.Points.Length);
        Assert.Equal(32.658, result.Points[0].Latitude, 3);
        Assert.Equal(-97.3236, result.Points[0].Longitude, 4);
        Assert.Equal(6.5, result.Points[0].WindSpeedMph);
        Assert.Equal(270, result.Points[0].WindDirectionDegrees);
        Assert.False(cached.Stale);
        Assert.Contains("wind_speed_10m,wind_direction_10m", handler.LastRequest!.Query);
        Assert.Contains("latitude=32.658", handler.LastRequest.Query);
        Assert.Contains("longitude=-97.3236", handler.LastRequest.Query);
    }

    [Fact]
    public async Task ReturnsStaleWindGridAfterUpstreamFailureAndHonorsCache()
    {
        var requests = 0;
        var (service, _, clock) = Create(_ => ++requests == 1
            ? Response(HttpStatusCode.OK, WindPayload())
            : Response(HttpStatusCode.BadGateway, "{}"));
        var initial = await service.GetRegionalWind(CancellationToken.None);
        _ = await service.GetRegionalWind(CancellationToken.None);
        Assert.Equal(1, requests);
        clock.Advance(TimeSpan.FromMinutes(16));
        var stale = await service.GetRegionalWind(CancellationToken.None);
        Assert.Equal(2, requests);
        Assert.True(stale.Stale);
        Assert.Equal(initial.ValidTime, stale.ValidTime);
        Assert.True((await service.GetRegionalWind(CancellationToken.None)).Stale);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("bad-direction")]
    [InlineData("mismatched-time")]
    public async Task RejectsMalformedRegionalGridWithoutServingItAsLive(string variant)
    {
        var payload = WindPayload(variant);
        var (service, _, _) = Create(_ => Response(HttpStatusCode.OK, payload));
        var error = await Assert.ThrowsAsync<DashboardException>(() => service.GetRegionalWind(CancellationToken.None));
        Assert.Equal(503, error.Status);
    }

    [Fact]
    public async Task MapsMissingCurrentMetricAsUnavailableWeatherResponse()
    {
        var malformed = Payload.Replace(",\"relative_humidity_2m\":58", "", StringComparison.Ordinal);
        var (service, _, _) = Create(_ => Response(HttpStatusCode.OK, malformed));
        var error = await Assert.ThrowsAsync<DashboardException>(() => service.GetForecast(CancellationToken.None));
        Assert.Equal(503, error.Status);
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

    private static string WindPayload(string variant = "valid") => System.Text.Json.JsonSerializer.Serialize(
        Enumerable.Range(0, 25).Select(index => new Dictionary<string, object>
        {
            ["current"] = new Dictionary<string, object>
            {
                ["time"] = variant == "mismatched-time" && index == 24 ? "2026-09-26T10:00" : "2026-09-26T09:00",
                ["wind_speed_10m"] = 6.5 + index,
                ["wind_direction_10m"] = variant == "bad-direction" && index == 4 ? 400 : 270,
            }.Where(pair => !(variant == "missing" && index == 0 && pair.Key == "wind_direction_10m"))
             .ToDictionary(pair => pair.Key, pair => pair.Value)
        }));

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
