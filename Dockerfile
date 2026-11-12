FROM node:24-bookworm-slim AS web
WORKDIR /source/web
COPY src/web/package*.json ./
RUN npm ci
COPY src/web/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api
WORKDIR /source
COPY src/api/SmartTv.Api.csproj src/api/
RUN dotnet restore src/api/SmartTv.Api.csproj
COPY src/api/ src/api/
RUN dotnet publish src/api/SmartTv.Api.csproj -c Release -o /app --no-restore
COPY --from=web /source/web/dist /app/wwwroot

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=api /app ./
# /app/state: encrypted settings (Milestone 3 volume). /app/data: small runtime state that should
# survive restarts and redeploys (last good forecast, hashed phone-remote sessions), on the data volume.
RUN mkdir -p /app/state /app/data && chown "$APP_UID:$APP_UID" /app/state /app/data && chmod 700 /app/state /app/data
USER $APP_UID
ENV ASPNETCORE_URLS=http://+:8080 \
    Weather__CacheFile=/app/data/weather.json \
    Remote__SessionFile=/app/data/remote-sessions.json
EXPOSE 8080
ENTRYPOINT ["dotnet", "SmartTv.Api.dll"]
