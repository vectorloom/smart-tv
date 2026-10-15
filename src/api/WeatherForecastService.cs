using System.Globalization;
using System.Text.Json;

namespace SmartTv;

public sealed record WeatherOptions(double Latitude, double Longitude, string Location = "Dallas–Fort Worth")
{
    public static WeatherOptions FromConfiguration(IConfiguration config)
    {
        static double Coordinate(string? value, double fallback, double min, double max)
        {
            if (string.IsNullOrWhiteSpace(value)) return fallback;
            if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ||
                !double.IsFinite(parsed) || parsed < min || parsed > max)
                return double.NaN;
            return parsed;
        }

        return new(
            Coordinate(config["Weather:Latitude"], 32.7767, -90, 90),
            Coordinate(config["Weather:Longitude"], -96.7970, -180, 180),
            string.IsNullOrWhiteSpace(config["Weather:Location"])
                ? "Dallas–Fort Worth"
                : config["Weather:Location"]!.Trim());
    }
}

public sealed record WeatherPeriod(
    string Time, double TemperatureF, int WeatherCode, string Condition, int? PrecipitationProbability);
public sealed record CurrentWeather(
    string Time, double TemperatureF, int WeatherCode, string Condition, bool IsDay, int? PrecipitationProbability);
public sealed record DailyWeather(
    string Date, double HighF, double LowF, int WeatherCode, string Condition, int? PrecipitationProbability);
public sealed record WeatherForecast(
    string Location, DateTimeOffset LastUpdated, bool Stale, CurrentWeather Current,
    WeatherPeriod[] Hourly, DailyWeather[] Daily);

public sealed class WeatherForecastService(HttpClient http, WeatherOptions options, TimeProvider clock)
{
    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(20);
    private static readonly TimeSpan FailureRetryDelay = TimeSpan.FromMinutes(1);
    private readonly SemaphoreSlim gate = new(1, 1);
    private WeatherForecast? cached;
    private DateTimeOffset retryAfter;

    public async Task<WeatherForecast> GetForecast(CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        if (cached is { } available && now - available.LastUpdated < CacheDuration)
            return available with { Stale = false };

        await gate.WaitAsync(ct);
        try
        {
            now = clock.GetUtcNow();
            if (cached is { } fresh && now - fresh.LastUpdated < CacheDuration)
                return fresh with { Stale = false };
            if (now < retryAfter)
                return cached is { } old ? old with { Stale = true } : throw Unavailable();

            try
            {
                var result = await Fetch(ct);
                cached = result with { LastUpdated = clock.GetUtcNow(), Stale = false };
                retryAfter = DateTimeOffset.MinValue;
                return cached;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception)
            {
                retryAfter = clock.GetUtcNow().Add(FailureRetryDelay);
                if (cached is { } stale) return stale with { Stale = true };
                throw Unavailable();
            }
        }
        finally { gate.Release(); }
    }

    private async Task<WeatherForecast> Fetch(CancellationToken ct)
    {
        if (!double.IsFinite(options.Latitude) || !double.IsFinite(options.Longitude))
            throw new InvalidOperationException("Weather coordinates are invalid.");
        var uri = $"https://api.open-meteo.com/v1/forecast?latitude={options.Latitude.ToString(CultureInfo.InvariantCulture)}" +
            $"&longitude={options.Longitude.ToString(CultureInfo.InvariantCulture)}&current=temperature_2m,weather_code,is_day" +
            "&hourly=temperature_2m,weather_code,precipitation_probability" +
            "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
            "&temperature_unit=fahrenheit&timezone=America%2FChicago&forecast_days=7";
        using var response = await http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException("Weather provider returned an unsuccessful response.");
        if (response.Content.Headers.ContentLength is > 1_000_000) throw new JsonException("Weather response too large.");
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var payload = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int read;
        while ((read = await stream.ReadAsync(buffer, ct)) > 0)
        {
            if (payload.Length + read > 1_000_000) throw new JsonException("Weather response too large.");
            await payload.WriteAsync(buffer.AsMemory(0, read), ct);
        }
        payload.Position = 0;
        using var document = await JsonDocument.ParseAsync(payload, cancellationToken: ct);
        var root = document.RootElement;
        var current = root.GetProperty("current");
        var hourly = root.GetProperty("hourly");
        var daily = root.GetProperty("daily");
        var hourlyTimes = hourly.GetProperty("time").EnumerateArray().Select(s => s.GetString()!).ToArray();
        var hourlyTemps = hourly.GetProperty("temperature_2m").EnumerateArray().Select(n => n.GetDouble()).ToArray();
        var hourlyCodes = hourly.GetProperty("weather_code").EnumerateArray().Select(n => n.GetInt32()).ToArray();
        var hourlyPrecip = hourly.GetProperty("precipitation_probability").EnumerateArray().Select(NumberOrNull).ToArray();
        var currentTime = current.GetProperty("time").GetString()!;
        var currentIndex = Array.FindIndex(hourlyTimes, t => string.CompareOrdinal(t, currentTime) >= 0);
        int? currentPrecip = currentIndex >= 0 && currentIndex < hourlyPrecip.Length ? hourlyPrecip[currentIndex] : null;
        var currentCode = current.GetProperty("weather_code").GetInt32();
        var currentWeather = new CurrentWeather(currentTime, current.GetProperty("temperature_2m").GetDouble(),
            currentCode, Describe(currentCode), current.GetProperty("is_day").GetInt32() == 1, currentPrecip);

        var hourlyItems = Enumerable.Range(Math.Max(0, currentIndex), Math.Min(12, Math.Max(0, hourlyTimes.Length - Math.Max(0, currentIndex))))
            .Select(i => new WeatherPeriod(hourlyTimes[i], hourlyTemps[i], hourlyCodes[i], Describe(hourlyCodes[i]),
                i < hourlyPrecip.Length ? hourlyPrecip[i] : null)).ToArray();
        var dailyTimes = daily.GetProperty("time").EnumerateArray().Select(s => s.GetString()!).ToArray();
        var dailyHigh = daily.GetProperty("temperature_2m_max").EnumerateArray().Select(n => n.GetDouble()).ToArray();
        var dailyLow = daily.GetProperty("temperature_2m_min").EnumerateArray().Select(n => n.GetDouble()).ToArray();
        var dailyCodes = daily.GetProperty("weather_code").EnumerateArray().Select(n => n.GetInt32()).ToArray();
        var dailyPrecip = daily.GetProperty("precipitation_probability_max").EnumerateArray().Select(NumberOrNull).ToArray();
        var days = Enumerable.Range(0, Math.Min(7, dailyTimes.Length)).Select(i => new DailyWeather(
            dailyTimes[i], dailyHigh[i], dailyLow[i], dailyCodes[i], Describe(dailyCodes[i]),
            i < dailyPrecip.Length ? dailyPrecip[i] : null)).ToArray();
        if (hourlyItems.Length == 0 || days.Length != 7) throw new JsonException("Weather forecast is incomplete.");
        return new(options.Location, clock.GetUtcNow(), false, currentWeather, hourlyItems, days);
    }

    private static int? NumberOrNull(JsonElement value) => value.ValueKind == JsonValueKind.Number ? (int)Math.Round(value.GetDouble()) : null;

    public static string Describe(int code) => code switch
    {
        0 => "Clear sky", 1 => "Mainly clear", 2 => "Partly cloudy", 3 => "Overcast",
        45 => "Fog", 48 => "Freezing fog", 51 => "Light drizzle", 53 => "Drizzle", 55 => "Heavy drizzle",
        56 or 57 => "Freezing drizzle", 61 => "Light rain", 63 => "Rain", 65 => "Heavy rain",
        66 or 67 => "Freezing rain", 71 => "Light snow", 73 => "Snow", 75 => "Heavy snow", 77 => "Snow grains",
        80 => "Light showers", 81 => "Showers", 82 => "Heavy showers", 85 => "Snow showers", 86 => "Heavy snow showers",
        95 => "Thunderstorm", 96 => "Thunderstorm with hail", 97 or 99 => "Severe thunderstorm", _ => "Weather unavailable"
    };

    private static DashboardException Unavailable() => new(503, "Weather is temporarily unavailable. Please try again later.");
}
