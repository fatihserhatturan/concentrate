using ConfigDemo.Options;
using Microsoft.Extensions.Options;

namespace ConfigDemo.Services;

public class StorageMonitor
{
    private StorageOptions _current;

    public StorageMonitor(IOptionsMonitor<StorageOptions> monitor)
    {
        _current = monitor.CurrentValue;
        monitor.OnChange(updated => _current = updated);
    }

    public string Container => _current.Container;
}
