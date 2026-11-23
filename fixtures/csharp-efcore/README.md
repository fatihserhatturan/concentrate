# csharp-efcore

Phase 47 track A: EF Core (library `efcore`). A small shop service (`Shop.csproj`) with two DbContexts, a repository, services, a controller
and minimal endpoints. `tests/csharp-efcore.test.ts` asserts the facts below.

## Tables and DataModels (`datamodel:efcore:<ns>:<Entity>` -MAPS_TO_TABLE-> `table:csharp:-:<lower name>`)

| Entity | Table | How the name is found |
| --- | --- | --- |
| Customer | `Customers` | convention: DbSet property name |
| Order | `Orders` | convention: DbSet property name |
| Product | `catalog_products`, schema `shop` | `[Table("catalog_products", Schema = "shop")]` |
| Invoice | `invoices`, schema `billing` | `modelBuilder.Entity<Invoice>().ToTable("invoices", "billing")` |
| Payment | `payments` | `modelBuilder.Entity<Payment>(e => { e.ToTable("payments"); ... })` |
| InvoiceLine | `invoice_lines`, schema `billing` | `IEntityTypeConfiguration<InvoiceLine>.Configure`: `builder.ToTable(..)` |

No model and no table: `AuditView` (`[NotMapped]`) and `Draft` (`modelBuilder.Ignore<Draft>()`).

Columns: `Product.Sku` is column `sku_code` (`[Column]`), `ProductKey` is the id (`[Key]`); `Payment.PaidAmount` is `paid_amount` and
`InvoiceLine.Description` is `line_text` (`HasColumnName`); `Customer.Email` is optional (`string?`); `migrations/001_init.sql` adds
`Customers.CreatedAt` (sql.schema merge) and declares `order_archive`.

## ACCESSES_DATA (library `efcore`, direct, `function operation model expression`)

- `OrderRepository`: `OpenAsync` read Order `_db.Orders.Where`; `GetAsync` read Order `_db.Orders.FindAsync`; `AddAsync` create Order; `Cancel` delete Order;
  `CountAsync` aggregate Order; `CustomerNamesAsync` read Customer (`from c in _db.Customers`); `RepriceAsync` update Product
  (`_db.Set<Product>().ExecuteUpdateAsync`).
- Raw SQL, operation of the SQL: `ShippedAsync` read `orders` (`FromSqlRaw(const)`); `PurgeAsync` delete `order_archive`
  (`ExecuteSqlInterpolatedAsync`); `ByDomainAsync` read `customers` (`FromSql($"...")`); `AllProductsRawAsync` (`EXEC GetProducts`, no table) reads
  the Product entity; `ReportService.CleanupAsync` delete `customers` (`ExecuteSqlRawAsync`).
- `ReportService` (primary constructor): `RevenueAsync` aggregate Order; `HasProductAsync` read Product.
- `BillingService` / `ArchiveService` (`using var ctx = new BillingContext()`, `IDbContextFactory<BillingContext>`): read Invoice, create Payment and
  InvoiceLine (`AddRange`), aggregate Payment.
- The contexts' own members: `ShopContext.CountActiveCustomersAsync` aggregate Customer (`Customers.CountAsync`), `Archive` delete Order
  (`this.Orders.Remove`) and update Customer (`Set<Customer>().Update`).
- `Program.cs` minimal endpoint `(ShopContext db) => db.Customers.Where(..)`: read Customer from `<top-level>`.
- `direct: false` reaches `GET /api/orders`, `POST /api/orders` and the callers.

## Nothing recorded (negatives)

`LocalCatalog` (`List<Order> Orders`, a `FakeSet<Customer> Customers`, a local `List<Order>`; none is a DbContext), `_db.Entry(order)`, the DbSet of an
ignored/`[NotMapped]` entity (`Drafts`), the getter `Products => Set<Product>()`.
