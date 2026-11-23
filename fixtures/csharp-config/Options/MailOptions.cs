namespace ConfigDemo.Options;

public class MailOptions
{
    public string Host { get; set; } = "";
    public int Port { get; set; }
    public bool UseSsl { get; set; }
    public List<string> Recipients { get; set; } = new();
}
