using System.ComponentModel.DataAnnotations;

namespace Shop.Models;

// Convention: the table is named after the DbSet property (ShopContext.Customers).
public class Customer
{
    public int Id { get; set; }

    [Required]
    public string Name { get; set; } = "";

    public string? Email { get; set; }

    public bool Active { get; set; }
}
