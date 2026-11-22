using Microsoft.AspNetCore.Mvc;

namespace Catalog.Api.Controllers;

public class ProductsController : ApiControllerBase
{
    private readonly IProductStore _store;

    public ProductsController(IProductStore store) => _store = store;

    [HttpGet]
    public IActionResult List() => Ok(_store.All());

    [HttpGet("{id:int}", Name = "GetProduct")]
    public IActionResult Get(int id) => Ok(_store.Find(id));

    [HttpPost]
    public IActionResult Create([FromBody] Product product) => Created("", product);

    [HttpPut("{id:int}")]
    [HttpPatch("{id:int}")]
    public IActionResult Update(int id, [FromBody] Product product) => NoContent();

    [HttpDelete("/api/legacy/products/{id}")]
    public IActionResult Remove(int id) => NoContent();

    [HttpGet("~/health/products")]
    public IActionResult Health() => Ok();

    [HttpGet("search/{**query}")]
    public async Task<IActionResult> SearchAsync(string query) => Ok(await Task.FromResult(query));

    [AcceptVerbs("GET", "HEAD", Route = "exists/{id}")]
    public IActionResult Exists(int id) => Ok();

    [Route("export")]
    public IActionResult Export() => Ok();

    public override IActionResult Version() => Ok("2");

    public static IActionResult Static() => null!;

    private IActionResult Secret() => Ok();
}

public interface IProductStore
{
    IEnumerable<Product> All();
    Product? Find(int id);
}

public record Product(int Id, string Name);
