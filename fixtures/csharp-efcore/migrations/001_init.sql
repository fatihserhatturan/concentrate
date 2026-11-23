CREATE TABLE Customers (
    Id INT NOT NULL PRIMARY KEY,
    Name NVARCHAR(200) NOT NULL,
    Email NVARCHAR(200) NULL,
    Active BIT NOT NULL,
    CreatedAt DATETIME2 NOT NULL
);

CREATE TABLE order_archive (
    OrderId INT NOT NULL,
    age INT NOT NULL
);
