namespace Shop.Models;

public class Invoice
{
    public int Id { get; set; }
    public int OrderId { get; set; }
    public decimal Amount { get; set; }
}

public class Payment
{
    public int Id { get; set; }
    public int InvoiceId { get; set; }
    public decimal PaidAmount { get; set; }
}

public class InvoiceLine
{
    public int Id { get; set; }
    public int InvoiceId { get; set; }
    public string? Description { get; set; }
}

public class Draft
{
    public int Id { get; set; }
}
