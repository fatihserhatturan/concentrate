import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { GraphBuilder } from "../src/core/graph/builder.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { csharpDiContributor, resolveCSharpInjection } from "../src/integrations/frameworks/csharp/di.js";
import { csharpFrameworkParser } from "../src/integrations/frameworks/csharp/index.js";
import { openTestStore } from "./helpers/store.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

function injections(graph: Graph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "INJECTS")
    .map((rel) => `${byId.get(rel.from)!.properties.name} -> ${byId.get(rel.to)!.properties.name} ${rel.properties.fieldName} ${rel.properties.via}`)
    .sort();
}

const temporary: string[] = [];
after(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

async function scanSources(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-di-"));
  temporary.push(dir);
  await writeFile(path.join(dir, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return buildCodeGraph(dir, { continueOnError: false });
}

const classNamed = (graph: Graph, name: string) => graph.nodes.find((node) => node.label === "Class" && node.properties.name === name)!;

describe("C# dependency injection (fixtures/csharp-di)", () => {
  it("links constructor, primary-constructor, [FromServices] and keyed injection", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-di"), { continueOnError: false });
    assert.deepEqual(injections(graph), [
      "CheckoutService -> SqlOrderRepository repository constructor",
      "CheckoutService -> SystemClock clock constructor",
      "OrderProjector -> PricingEngine Pricing primary-constructor",
      "OrderProjector -> SqlOrderRepository Repository primary-constructor",
      "OrderService -> SqlOrderRepository repository constructor",
      "OrderService -> SystemClock clock constructor",
      "OrdersController -> EmailNotifier notifiers constructor",
      "OrdersController -> MemoryCache local from-services",
      "OrdersController -> OrderService orders constructor",
      "OrdersController -> PricingEngine pricing from-services",
      "OrdersController -> RedisCache cache from-services",
      "OrdersController -> Repository repository constructor",
      "OrdersController -> SmsNotifier notifiers constructor",
      "PricingEngine -> SystemClock clock constructor",
      "ReminderWorker -> OrderService orders constructor",
      "ReportBuilder -> EmailNotifier notifiers constructor",
      "ReportBuilder -> SmsNotifier notifiers constructor",
      "ReportsController -> PaymentGateway gateway primary-constructor",
      "ReportsController -> ReportBuilder reports primary-constructor",
      "ReportsController -> SystemClock clock primary-constructor",
      "SqlOrderRepository -> AuditLog audit constructor",
    ]);
  });

  it("marks providers with their lifetime and counts the ambiguous INotifier point only", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-di"), { continueOnError: false });
    const classes = graph.nodes.filter((node) => node.label === "Class");
    const roles = classes.filter((node) => node.properties.diStereotype).map((node) => `${node.properties.name}:${node.properties.diStereotype}:${node.properties.diBeanName}`).sort();
    assert.deepEqual(roles, [
      "AuditLog:Singleton:AuditLog",
      "CheckoutService:Transient:CheckoutService",
      "EmailNotifier:Transient:EmailNotifier",
      "MemoryCache:Singleton:MemoryCache",
      "OrderProjector:Scoped:OrderProjector",
      "OrderService:Scoped:OrderService",
      "PaymentGateway:Transient:PaymentGateway",
      "PricingEngine:Scoped:PricingEngine",
      "RedisCache:Singleton:RedisCache",
      "ReportBuilder:Scoped:ReportBuilder",
      "Repository:Scoped:Repository",
      "SmsNotifier:Transient:SmsNotifier",
      "SqlOrderRepository:Scoped:SqlOrderRepository",
      "SystemClock:Singleton:SystemClock",
    ]);
    const ambiguous = classes.filter((node) => node.properties.ambiguousInjections).map((node) => `${node.properties.name}:${node.properties.ambiguousInjections}`);
    assert.deepEqual(ambiguous, ["OrdersController:1"]);
    // The unregistered Scratch, the unknown-type factory ITaxPolicy and the unregistered IFormatter produce nothing.
    const names = new Set(injections(graph).join("\n").split("\n"));
    assert.ok(![...names].some((line) => /Scratch|FlatTax|IFormatter/u.test(line)));
  });

  it("impact_of an implementation method reaches the controller and the worker through the injected interface", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-di"), { continueOnError: false });
    const store = await openTestStore(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-csharp-di-store-")), "graph"));
    try {
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const tool = async (args: Record<string, unknown>) => JSON.parse((await callMcpTool(store, "impact_of", args)).content[0]?.text ?? "{}") as { seeds: Array<{ className: string; name: string }>; callers: Array<{ className: string; name: string }> };
      const labels = (rows: Array<{ className: string; name: string }>) => rows.map((row) => `${row.className}.${row.name}`).sort();
      const impl = await tool({ symbol: "Save", file: "Implementations.cs" });
      assert.deepEqual(labels(impl.seeds), ["SqlOrderRepository.Save"]);
      assert.deepEqual(labels(impl.callers), ["OrderService.Place", "OrdersController.Create", "ReminderWorker.ExecuteAsync"]);
      const iface = await tool({ symbol: "Save", file: "Contracts.cs" });
      assert.deepEqual(labels(iface.seeds), ["IOrderRepository.Save"]);
      assert.deepEqual(labels(iface.callers), labels(impl.callers));
      const price = await tool({ symbol: "Price", file: "Implementations.cs" });
      assert.deepEqual(labels(price.callers), ["OrderProjector.Total", "OrdersController.Price"]);
    } finally {
      await store.close();
    }
  });
});

describe("C# dependency injection resolution rules", () => {
  const PREAMBLE = "using Microsoft.AspNetCore.Mvc;\nusing Microsoft.Extensions.DependencyInjection;\nusing Microsoft.Extensions.DependencyInjection.Extensions;\nnamespace App;\n";

  it("reads every registration shape", async () => {
    const graph = await scanSources({
      "Types.cs": `${PREAMBLE}
public interface IA {} public class A : IA {}
public interface IB {} public class B : IB {}
public interface IC {} public class C : IC {}
public interface ID {} public class D : ID {}
public interface IE {} public class E : IE { public E(Dep d) {} }
public interface IF {} public class F : IF {}
public interface IG {} public class G : IG {}
public class Dep {}
public class Plain {}
public class Host { public Host(IA a, IB b, IC c, ID d, IE e, IF f, IG g, Dep dep, Plain plain) {} }
public static class Reg {
  public static IServiceCollection AddAll(this IServiceCollection services) {
    services.AddSingleton(typeof(IA), typeof(A));
    services.TryAddTransient<IB, B>();
    services.AddScoped<IC>(sp => new C());
    services.AddScoped<ID>(sp => { return new D(); });
    services.AddSingleton<IE>(new E(new Dep()));
    services.AddScoped<IF>(sp => Make(sp));
    services.AddScoped<IG>(sp => { var g = new G(); return g; });
    services.AddScoped<Dep>();
    services.AddScoped<Host>();
    return services;
  }
  static IF Make(System.IServiceProvider sp) => new F();
}
`,
    });
    // IF and IG are factories of unknown type: nothing linked, nothing counted (one candidate each).
    assert.deepEqual(injections(graph), [
      "E -> Dep d constructor",
      "Host -> A a constructor",
      "Host -> B b constructor",
      "Host -> C c constructor",
      "Host -> D d constructor",
      "Host -> Dep dep constructor",
      "Host -> E e constructor",
    ]);
    assert.equal(classNamed(graph, "Host").properties.ambiguousInjections, undefined);
    assert.equal(classNamed(graph, "A").properties.diStereotype, "Singleton");
    assert.equal(classNamed(graph, "B").properties.diStereotype, "Transient");
    assert.equal(classNamed(graph, "F").properties.diStereotype, undefined);
    assert.equal(classNamed(graph, "E").properties.diStereotype, "Singleton");
  });

  it("picks the constructor with the most parameters, ignores a tie and non-public constructors", async () => {
    const graph = await scanSources({
      "Types.cs": `${PREAMBLE}
public class Dep1 {} public class Dep2 {}
public class Many { public Many(Dep1 a) {} public Many(Dep1 a, Dep2 b) {} private Many(Dep2 c, Dep1 d, Dep1 e) {} }
public class Tie { public Tie(Dep1 a) {} public Tie(Dep2 b) {} }
public class Primary(Dep1 a) { public Primary(Dep1 a, Dep2 b) : this(a) {} }
public static class Reg { public static void Add(IServiceCollection s) { s.AddScoped<Dep1>(); s.AddScoped<Dep2>(); s.AddScoped<Many>(); s.AddScoped<Tie>(); s.AddScoped<Primary>(); } }
`,
    });
    assert.deepEqual(injections(graph), ["Many -> Dep1 a constructor", "Many -> Dep2 b constructor", "Primary -> Dep1 a constructor", "Primary -> Dep2 b constructor"]);
    assert.ok(graph.nodes.every((node) => node.properties.ambiguousInjections === undefined));
  });

  it("counts two or more implementations as ambiguous, also last-wins style duplicates, but not one implementation twice", async () => {
    const graph = await scanSources({
      "Types.cs": `${PREAMBLE}
public interface IRepo {} public class R1 : IRepo {} public class R2 : IRepo {}
public interface IOnce {} public class Once : IOnce {}
public interface IGone {}
public class Consumer { public Consumer(IRepo repo, IOnce once, IGone gone, IEnumerable<IRepo> all, IEnumerable<IGone> none) {} }
public static class Reg { public static void Add(IServiceCollection s) {
  s.AddScoped<IRepo, R1>(); s.AddScoped<IRepo, R2>();
  s.AddScoped<IOnce, Once>(); s.TryAddScoped<IOnce, Once>();
  s.AddScoped<Consumer>();
} }
`,
    });
    assert.deepEqual(injections(graph), ["Consumer -> Once once constructor", "Consumer -> R1 all constructor", "Consumer -> R2 all constructor"]);
    assert.equal(classNamed(graph, "Consumer").properties.ambiguousInjections, 1);
  });

  it("matches closed generics, open generics and keys without guessing", async () => {
    const graph = await scanSources({
      "Types.cs": `${PREAMBLE}
public interface IRepo<T> {} public class Repo<T> : IRepo<T> {}
public interface IHandler<T> {} public class UserHandler : IHandler<User> {} public class OrderHandler : IHandler<Order> {}
public class User {} public class Order {}
public interface ICache {} public class Mem : ICache {} public class Redis : ICache {} public class Any : ICache {}
public class Consumer {
  public Consumer(IRepo<User> users, IHandler<User> uh, IHandler<Order> oh, IHandler<Missing> mh,
    [FromKeyedServices("mem")] ICache mem, [FromKeyedServices("redis")] ICache redis, [FromKeyedServices("nope")] ICache nope, ICache plain, [FromKeyedServices(Keys.Dyn)] ICache dyn) {}
}
public class Missing {}
public static class Keys { public const string Dyn = "x"; }
public static class Reg { public static void Add(IServiceCollection s) {
  s.AddScoped(typeof(IRepo<>), typeof(Repo<>));
  s.AddScoped<IHandler<User>, UserHandler>(); s.AddScoped<IHandler<Order>, OrderHandler>();
  s.AddKeyedScoped<ICache, Mem>("mem"); s.AddKeyedScoped(typeof(ICache), "redis", typeof(Redis));
  s.AddScoped<Consumer>();
} }
`,
    });
    // `plain` (unkeyed) sees no unkeyed ICache; `nope` has no such key; `dyn` has an unresolvable key and two candidates: counted.
    assert.deepEqual(injections(graph), [
      "Consumer -> Mem mem constructor",
      "Consumer -> OrderHandler oh constructor",
      "Consumer -> Redis redis constructor",
      "Consumer -> Repo users constructor",
      "Consumer -> UserHandler uh constructor",
    ]);
    assert.equal(classNamed(graph, "Consumer").properties.ambiguousInjections, 1);
  });

  it("ignores framework types and never injects a type that is not registered", async () => {
    const graph = await scanSources({
      "Types.cs": `${PREAMBLE}
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
public class Opts {} public class Plain {}
public class S { public S(ILogger<S> log, IConfiguration cfg, IOptions<Opts> opts, Plain plain, S self) {} }
public static class Reg { public static void Add(IServiceCollection s) { s.AddScoped<S>(); s.Configure<Opts>(c => {}); } }
`,
    });
    assert.deepEqual(injections(graph), []);
    assert.ok(graph.nodes.every((node) => node.properties.ambiguousInjections === undefined));
  });

  it("injects [FromServices] parameters of controllers and records, and framework-created classes", async () => {
    const graph = await scanSources({
      "Types.cs": `${PREAMBLE}
public interface IClock {} public class Clock : IClock {}
public interface IThing {} public class Thing : IThing {}
public record Event(IClock Clock);
[ApiController] public class ThingsController : ControllerBase {
  [HttpGet] public IActionResult Get([FromServices] IClock clock, int id) => Ok();
  [HttpPost] public IActionResult Post([FromServices] IThing thing) => Ok();
}
public class Hub1 : Microsoft.AspNetCore.SignalR.Hub { public Hub1(IThing thing) {} }
public class Worker : BackgroundService { public Worker(IClock clock) {} }
public static class Reg { public static void Add(IServiceCollection s) { s.AddSingleton<IClock, Clock>(); s.AddSingleton<IThing, Thing>(); s.AddScoped<Event>(); } }
`,
    });
    assert.deepEqual(injections(graph), [
      "Event -> Clock Clock primary-constructor",
      "Hub1 -> Thing thing constructor",
      "ThingsController -> Clock clock from-services",
      "ThingsController -> Thing thing from-services",
      "Worker -> Clock clock constructor",
    ]);
  });
});

describe("C# injection helper for minimal-API handlers (wave 2)", () => {
  it("resolveCSharpInjection answers for a type written in a handler lambda", async () => {
    const root = path.resolve("fixtures/csharp-di");
    const builder = new GraphBuilder();
    for (const relative of await readdir(root, { recursive: true })) {
      if (!relative.endsWith(".cs")) continue;
      const parsed = await csharpFrameworkParser.parse(root, path.join(root, relative));
      builder.addNodes(parsed.nodes);
      builder.addRelationships(parsed.relationships);
    }
    csharpDiContributor.contribute(builder, root);
    const scope = builder.nodesWithLabel("Call").find((call) => call.properties.callee === "AddHttpClient")!; // written in a file that sees ShopDi.Orders
    assert.ok(scope);
    const one = resolveCSharpInjection(builder, "IOrderService", scope);
    assert.deepEqual(one.targets.map((node) => node.properties.name), ["OrderService"]);
    assert.equal(one.ambiguous, false);
    const ambiguous = resolveCSharpInjection(builder, "INotifier", scope);
    assert.deepEqual(ambiguous, { targets: [], ambiguous: true });
    assert.equal(resolveCSharpInjection(builder, "IEnumerable<INotifier>", scope).targets.length, 2);
    assert.equal(resolveCSharpInjection(builder, "IRepository<Order>", scope).targets[0]?.properties.name, "Repository");
    assert.deepEqual(resolveCSharpInjection(builder, "ICache", scope, { key: "redis" }).targets.map((node) => node.properties.name), ["RedisCache"]);
    assert.deepEqual(resolveCSharpInjection(builder, "HttpContext", scope), { targets: [], ambiguous: false });
    assert.deepEqual(resolveCSharpInjection(builder, "int", scope), { targets: [], ambiguous: false });
    assert.deepEqual(resolveCSharpInjection(builder, "ILogger<Foo>", scope), { targets: [], ambiguous: false });
  });
});
