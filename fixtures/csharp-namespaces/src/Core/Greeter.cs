using System.Text;
using Microsoft.Extensions.Logging;
using Acme.Missing.Library;
using static Acme.Shared.Constants;
using Money = Acme.Models.Money;

namespace Acme.Core
{
    public class Greeter
    {
        public string Greet(string name)
        {
            var sb = new StringBuilder();
            sb.Append(Prefix).Append(name);
            Money m = new Money(5);
            return sb.ToString() + m.Amount;
        }
    }
}
