namespace Acme.Util
{
    public static class MathUtil
    {
        public static int Square(int x) => x * x;
        public static int Sum(int a, int b) => a + b;
        public static int Sum(int a, int b, int c) => a + b + c;
        public static string Fmt(int a, string b) => b + a;
        public static string Fmt(string a, int b) => a + b;
        public static string Fmt(object a, object b) => a + "" + b;
    }
}
