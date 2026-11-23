using Microsoft.AspNetCore.Mvc;
using Todos.Api.Endpoints;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<ITodoService, TodoService>();

var app = builder.Build();

app.MapGet("/", () => "Todos API");
app.MapGet("/health", () => Results.Ok());

var api = app.MapGroup("/api");
var v1 = api.MapGroup("/v1").RequireAuthorization();

v1.MapGet("/todos", (ITodoService todos) => todos.All());
v1.MapGet("/todos/{id:int}", TodoHandlers.GetTodo);
v1.MapPost("/todos", TodoHandlers.CreateTodo);
v1.MapPut("/todos/{id:int}", ([FromServices] ITodoService todos, int id, Todo todo) => todos.Replace(id, todo));
v1.MapDelete("/todos/{id:int}", DeleteTodo);

api.MapMethods("/todos/{id:int}/archive", new[] { "POST", "PUT" }, TodoHandlers.Archive);
api.MapMethods("/ping", ["GET", "HEAD"], () => "pong");
api.Map("/any", () => "any");

app.MapGroup("/admin").MapGet("/stats", (ITodoService todos) => todos.Count());

app.MapTodoReports();

app.MapGet(Routes.Export, TodoHandlers.Export);
app.MapGet($"/{Routes.Version}/info", () => "info");

app.Run();

static IResult DeleteTodo(int id, ITodoService todos) => todos.Remove(id) ? Results.NoContent() : Results.NotFound();
