using System;

namespace Acme.Lib;

public class UsedPublic
{
    public void UsedMethod() { }
    public void UnusedMethod() { }
    internal void UsedInternal() { }
    internal void UnusedInternal() { }
    private void UnusedPrivate() { }
    private int unusedField;
    public int UsedProp { get; set; }
    public int UnusedProp { get; set; }
}

public class UnusedPublicClass { }
internal class UnusedInternalClass { }
internal class UsedInternalClass { }

public interface IThing { void Do(); }
public class ThingImpl : IThing
{
    public void Do() { }                       // interface impl: exempt
    public override string ToString() => "t";  // override: exempt
}

public class Attributed
{
    [Obsolete]
    public void MarkedMethod() { }             // attribute-annotated: exempt
}

[AttributeUsage(AttributeTargets.All)]
public class MarkerAttribute : Attribute { }

[Marker]
public class MarkedClass { }                   // attribute-annotated: exempt

public enum UsedEnum { A, B }
public enum UnusedEnum { A, B }
