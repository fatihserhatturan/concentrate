namespace Acme.Ext
{
    public static class StringExtensions
    {
        public static string Shout(this string s) => s.ToUpperInvariant() + "!";
        public static int WordCount(this string s) => s.Split(' ').Length;
    }
}
