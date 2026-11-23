using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace Fulfilment.Service.Data;

[Table("orders")]
public class Order
{
    [Key]
    public int Id { get; set; }
    [Required]
    public string CustomerEmail { get; set; } = "";
    public string Status { get; set; } = "new";
    public List<OrderLine> Lines { get; set; } = new();
}

public class OrderLine
{
    public int Id { get; set; }
    public int OrderId { get; set; }
    public string Sku { get; set; } = "";
    public int Quantity { get; set; }
}
