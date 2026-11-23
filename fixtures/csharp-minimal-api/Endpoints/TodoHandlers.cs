namespace Todos.Api.Endpoints;

public record Todo(int Id, string Title, bool Done);

public interface ITodoService
{
    IEnumerable<Todo> All();
    Todo? Find(int id);
    Todo Add(Todo todo);
    Todo Replace(int id, Todo todo);
    bool Remove(int id);
    int Count();
}

public class TodoService : ITodoService
{
    private readonly List<Todo> _todos = new();

    public IEnumerable<Todo> All() => _todos;
    public Todo? Find(int id) => _todos.FirstOrDefault(todo => todo.Id == id);
    public Todo Add(Todo todo) { _todos.Add(todo); return todo; }
    public Todo Replace(int id, Todo todo) => todo;
    public bool Remove(int id) => _todos.RemoveAll(todo => todo.Id == id) > 0;
    public int Count() => _todos.Count;
}

public static class Routes
{
    public const string Export = "/export";
    public const string Version = "v2";
}

public static class TodoHandlers
{
    public static IResult GetTodo(int id, ITodoService todos) => todos.Find(id) is { } todo ? Results.Ok(todo) : Results.NotFound();

    public static IResult CreateTodo(Todo todo, ITodoService todos) => Results.Created($"/todos/{todo.Id}", todos.Add(todo));

    public static IResult Archive(int id, ITodoService todos) => Results.NoContent();

    public static IResult Export(ITodoService todos) => Results.Ok(todos.All());
}
