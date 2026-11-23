using System.ComponentModel.DataAnnotations.Schema;

namespace Shop.Models;

[NotMapped]
public class AuditView
{
    public int Id { get; set; }
}
