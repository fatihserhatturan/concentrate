using System;
using System.Collections.Generic;

namespace Acme.Decl;

[Obsolete("use New", error: false, DiagnosticId = "ACME001")]
public class Members
{
    public int PublicField;
    internal int InternalField;
    protected int ProtectedField;
    private int privateField;
    protected internal int ProtInternalField;
    private protected int PrivProtField;
    int defaultField;

    public int AutoProp { get; set; }
    public string InitProp { get; init; } = "";
    public int ExprProp => privateField + defaultField;
    public int this[int i] => i;
    public string this[string key, int n] { get { return key; } set { } }
    public event EventHandler? Changed;
    public event Action<int> Tick { add { } remove { } }

    public Members() { }
    static Members() { }
    public Members(int x) : this() { privateField = x; }

    public void PublicMethod() { }
    internal void InternalMethod() { }
    protected void ProtectedMethod() { }
    private void PrivateMethod() { }
    protected internal void ProtInternalMethod() { }
    private protected void PrivProtMethod() { }
    void DefaultMethod() { }
    public static int Add(int a, int b) => a + b;

    [System.Diagnostics.Conditional("DEBUG")]
    public void Debug() { }

    public void OnChanged() => Changed?.Invoke(this, EventArgs.Empty);
}

class DefaultInternalClass { }
internal class ExplicitInternalClass { }
