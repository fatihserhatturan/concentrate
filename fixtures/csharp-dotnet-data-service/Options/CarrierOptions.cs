namespace Fulfilment.Service.Options;

public class CarrierOptions
{
    public string Endpoint { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public int TimeoutSeconds { get; set; }
}
