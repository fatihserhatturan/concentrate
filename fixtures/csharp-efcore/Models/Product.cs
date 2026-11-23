using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace Shop.Models;

[Table("catalog_products", Schema = "shop")]
public class Product
{
    [Key]
    public int ProductKey { get; set; }

    [Column("sku_code")]
    [Required]
    public string Sku { get; set; } = "";

    public decimal Price { get; set; }
}
