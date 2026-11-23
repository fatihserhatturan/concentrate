using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Shop.Models;

namespace Shop.Data;

public class BillingContext : DbContext
{
    public DbSet<Invoice> Invoices { get; set; }
    public DbSet<Payment> Payments { get; set; }
    public DbSet<InvoiceLine> Lines { get; set; }
    public DbSet<Draft> Drafts { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>().ToTable("invoices", "billing");
        modelBuilder.Entity<Payment>(e =>
        {
            e.ToTable("payments");
            e.Property(p => p.PaidAmount).HasColumnName("paid_amount");
        });
        modelBuilder.ApplyConfiguration(new InvoiceLineConfiguration());
        modelBuilder.Ignore<Draft>();
    }
}

public class InvoiceLineConfiguration : IEntityTypeConfiguration<InvoiceLine>
{
    public void Configure(EntityTypeBuilder<InvoiceLine> builder)
    {
        builder.ToTable("invoice_lines", "billing");
        builder.Property(l => l.Description).HasColumnName("line_text").IsRequired();
    }
}
