-- Tablas FISCALES de ejemplo del sandbox (Fase 7, tarea 7.3). El agente NUNCA debe escribir aquí:
-- facturas, sus renglones y las cuentas por cobrar son contabilidad. Existen (con datos) para que
-- las pruebas puedan demostrar que, después de procesar pedidos web, siguen idénticas.
-- Idempotente. Los nombres son de mejor esfuerzo, como el resto del sandbox.

USE SAINT_DEMO;
GO

-- Facturas.
IF OBJECT_ID(N'dbo.SAFACT', N'U') IS NULL
CREATE TABLE dbo.SAFACT (
    NumeroD   VARCHAR(20)   NOT NULL CONSTRAINT PK_SAFACT PRIMARY KEY,
    CodClie   VARCHAR(15)   NOT NULL CONSTRAINT FK_SAFACT_SACLIE REFERENCES dbo.SACLIE (CodClie),
    FechaE    DATE          NOT NULL,
    Monto     DECIMAL(18,2) NOT NULL,
    Impuesto  DECIMAL(18,2) NOT NULL CONSTRAINT DF_SAFACT_Impuesto DEFAULT 0
);
GO

-- Renglones de las facturas.
IF OBJECT_ID(N'dbo.SAITEMFAC', N'U') IS NULL
CREATE TABLE dbo.SAITEMFAC (
    NumeroD    VARCHAR(20)   NOT NULL CONSTRAINT FK_SAITEMFAC_SAFACT REFERENCES dbo.SAFACT (NumeroD),
    NroLinea   INT           NOT NULL,
    CodProd    VARCHAR(15)   NOT NULL CONSTRAINT FK_SAITEMFAC_SAPROD REFERENCES dbo.SAPROD (CodProd),
    Cantidad   DECIMAL(18,3) NOT NULL,
    Precio     DECIMAL(18,4) NOT NULL,
    TotalItem  DECIMAL(18,2) NOT NULL,
    CONSTRAINT PK_SAITEMFAC PRIMARY KEY (NumeroD, NroLinea)
);
GO

-- Cuentas por cobrar (lo que cada cliente debe por sus facturas).
IF OBJECT_ID(N'dbo.SAACXC', N'U') IS NULL
CREATE TABLE dbo.SAACXC (
    NroUnico   INT           NOT NULL CONSTRAINT PK_SAACXC PRIMARY KEY,
    CodClie    VARCHAR(15)   NOT NULL CONSTRAINT FK_SAACXC_SACLIE REFERENCES dbo.SACLIE (CodClie),
    NumeroD    VARCHAR(20)   NOT NULL CONSTRAINT FK_SAACXC_SAFACT REFERENCES dbo.SAFACT (NumeroD),
    FechaV     DATE          NOT NULL,
    Saldo      DECIMAL(18,2) NOT NULL
);
GO

-- Datos de ejemplo (solo si las tablas están vacías; reset.sql las vacía y esto las vuelve a llenar).
-- Tomados de los tres primeros clientes y productos del seed, así no dependen de códigos inventados.
IF NOT EXISTS (SELECT 1 FROM dbo.SAFACT)
BEGIN
    DECLARE @c TABLE (n INT IDENTITY(1,1), CodClie VARCHAR(15));
    INSERT INTO @c (CodClie) SELECT TOP 3 CodClie FROM dbo.SACLIE ORDER BY CodClie;
    DECLARE @p TABLE (n INT IDENTITY(1,1), CodProd VARCHAR(15), Precio DECIMAL(18,4));
    INSERT INTO @p (CodProd, Precio) SELECT TOP 3 CodProd, Precio1 FROM dbo.SAPROD ORDER BY CodProd;

    INSERT INTO dbo.SAFACT (NumeroD, CodClie, FechaE, Monto, Impuesto)
    SELECT 'F' + RIGHT('0000000' + CAST(c.n AS VARCHAR(10)), 7), c.CodClie, DATEADD(DAY, -c.n, '2026-11-20'),
           CAST(10 * c.n * p.Precio AS DECIMAL(18,2)), CAST(10 * c.n * p.Precio * 0.16 AS DECIMAL(18,2))
      FROM @c c JOIN @p p ON p.n = c.n;

    INSERT INTO dbo.SAITEMFAC (NumeroD, NroLinea, CodProd, Cantidad, Precio, TotalItem)
    SELECT 'F' + RIGHT('0000000' + CAST(c.n AS VARCHAR(10)), 7), 1, p.CodProd, 10 * c.n, p.Precio,
           CAST(10 * c.n * p.Precio AS DECIMAL(18,2))
      FROM @c c JOIN @p p ON p.n = c.n;

    INSERT INTO dbo.SAACXC (NroUnico, CodClie, NumeroD, FechaV, Saldo)
    SELECT c.n, c.CodClie, 'F' + RIGHT('0000000' + CAST(c.n AS VARCHAR(10)), 7), DATEADD(DAY, 30 - c.n, '2026-11-20'),
           CAST(10 * c.n * p.Precio AS DECIMAL(18,2))
      FROM @c c JOIN @p p ON p.n = c.n;
END
GO
