using System;

namespace Acme.Decl;

public class Repository<T> where T : class, new()
{
    public T Create() => new T();
}

public class Pair2<TKey, TValue>
    where TKey : notnull, IComparable<TKey>
    where TValue : struct
{
    public TKey Key = default!;
    public TValue Value;
}

public interface IMapper<in TIn, out TOut> { TOut Map(TIn input); }

public static class Util
{
    public static T Identity<T>(T value) where T : struct => value;
}
