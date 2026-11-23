namespace Acme.Greet.Server.Services;

// Plain user classes named like a generated base: nothing serves.
public class WidgetBase
{
    public virtual string Render() => "widget";
}

public class Panel : WidgetBase
{
    public override string Render() => "panel";
}
