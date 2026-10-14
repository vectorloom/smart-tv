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
RUN mkdir -p /app/state && chown "$APP_UID:$APP_UID" /app/state && chmod 700 /app/state
USER $APP_UID
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "SmartTv.Api.dll"]
