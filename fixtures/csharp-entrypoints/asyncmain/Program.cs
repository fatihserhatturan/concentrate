using System.Threading.Tasks;

namespace AsyncApp;

internal static class Entry
{
    private static async Task<int> Main(string[] args)
    {
        await Task.Delay(1);
        return 0;
    }
}
