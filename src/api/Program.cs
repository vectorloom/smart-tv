using SmartTv;

if (args.FirstOrDefault() is "provision-material" or "admin-create" or "admin-reset" or "recover-wrapping")
{
    var config = new ConfigurationBuilder().AddEnvironmentVariables().AddCommandLine(args.Skip(1).ToArray()).Build();
    // Bootstrap/recovery must not parse or contact Immich. In particular, an
    // environment album placeholder must not block creation of the administrator.
    Environment.ExitCode = Provisioning.Run(args[0], config);
    return;
}
try { await DashboardHost.Build(args).RunAsync(); }
catch { Console.Error.WriteLine("Dashboard startup failed. Check non-secret configuration, certificate paths, and storage permissions."); Environment.ExitCode = 1; }
