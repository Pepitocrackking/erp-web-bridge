-- Sandbox de Saint Enterprise: esquema (idempotente).
-- ADVERTENCIA: los nombres de tablas y columnas son de mejor esfuerzo según el conocimiento
-- público de Saint Enterprise. Varían entre versiones y deben validarse contra una base real.
-- Cualquier ajuste de nombres se refleja en mapping.saint.yaml, no en el código del agente.

IF DB_ID(N'SAINT_DEMO') IS NULL
    CREATE DATABASE SAINT_DEMO;
GO

USE SAINT_DEMO;
GO

-- Instancias (categorías de producto).
IF OBJECT_ID(N'dbo.SAINSTA', N'U') IS NULL
CREATE TABLE dbo.SAINSTA (
    CodInst  VARCHAR(10)  NOT NULL CONSTRAINT PK_SAINSTA PRIMARY KEY,
    Descrip  VARCHAR(60)  NOT NULL
);
GO

-- Depósitos (ubicaciones de inventario).
IF OBJECT_ID(N'dbo.SADEPO', N'U') IS NULL
CREATE TABLE dbo.SADEPO (
    CodUbic  VARCHAR(10)  NOT NULL CONSTRAINT PK_SADEPO PRIMARY KEY,
    Descrip  VARCHAR(60)  NOT NULL
);
GO

-- Productos. Costo y precios en USD. Existen es la existencia total (suma de SAEXIS).
IF OBJECT_ID(N'dbo.SAPROD', N'U') IS NULL
CREATE TABLE dbo.SAPROD (
    CodProd  VARCHAR(15)   NOT NULL CONSTRAINT PK_SAPROD PRIMARY KEY,
    Descrip  VARCHAR(120)  NOT NULL,
    CodInst  VARCHAR(10)   NULL CONSTRAINT FK_SAPROD_SAINSTA REFERENCES dbo.SAINSTA (CodInst),
    Costo    DECIMAL(18,4) NOT NULL CONSTRAINT DF_SAPROD_Costo   DEFAULT 0,
    Precio1  DECIMAL(18,4) NOT NULL CONSTRAINT DF_SAPROD_Precio1 DEFAULT 0,
    Precio2  DECIMAL(18,4) NOT NULL CONSTRAINT DF_SAPROD_Precio2 DEFAULT 0,
    Precio3  DECIMAL(18,4) NOT NULL CONSTRAINT DF_SAPROD_Precio3 DEFAULT 0,
    Existen  DECIMAL(18,3) NOT NULL CONSTRAINT DF_SAPROD_Existen DEFAULT 0,
    Activo   TINYINT       NOT NULL CONSTRAINT DF_SAPROD_Activo  DEFAULT 1
);
GO

-- Existencia por depósito.
IF OBJECT_ID(N'dbo.SAEXIS', N'U') IS NULL
CREATE TABLE dbo.SAEXIS (
    CodProd  VARCHAR(15)   NOT NULL CONSTRAINT FK_SAEXIS_SAPROD REFERENCES dbo.SAPROD (CodProd),
    CodUbic  VARCHAR(10)   NOT NULL CONSTRAINT FK_SAEXIS_SADEPO REFERENCES dbo.SADEPO (CodUbic),
    Existen  DECIMAL(18,3) NOT NULL CONSTRAINT DF_SAEXIS_Existen DEFAULT 0,
    CONSTRAINT PK_SAEXIS PRIMARY KEY (CodProd, CodUbic)
);
GO

-- Clientes. ID3 es el RIF. LimiteCred y Saldo en USD.
IF OBJECT_ID(N'dbo.SACLIE', N'U') IS NULL
CREATE TABLE dbo.SACLIE (
    CodClie     VARCHAR(15)   NOT NULL CONSTRAINT PK_SACLIE PRIMARY KEY,
    Descrip     VARCHAR(120)  NOT NULL,
    ID3         VARCHAR(20)   NOT NULL,
    LimiteCred  DECIMAL(18,2) NOT NULL CONSTRAINT DF_SACLIE_Limite DEFAULT 0,
    Saldo       DECIMAL(18,2) NOT NULL CONSTRAINT DF_SACLIE_Saldo  DEFAULT 0,
    Activo      TINYINT       NOT NULL CONSTRAINT DF_SACLIE_Activo DEFAULT 1
);
GO

-- ---------------------------------------------------------------------------------------------
-- Pedidos de la web (Fase 7). El agente SOLO escribe aquí, siempre como borrador (Estado = 'B'):
-- nunca en las tablas fiscales. Un operador del ERP revisa el borrador y decide si lo convierte
-- en documento. NumeroWeb es el id del pedido web y es UNIQUE: así reintentar no duplica.
-- ---------------------------------------------------------------------------------------------

-- Correlativo de los borradores (PW0000001, PW0000002...).
IF OBJECT_ID(N'dbo.SQ_SAPEDIDO_WEB', N'SO') IS NULL
CREATE SEQUENCE dbo.SQ_SAPEDIDO_WEB AS INT START WITH 1 INCREMENT BY 1;
GO

-- Cabecera del borrador. Monto en USD y Tasa = Bs por USD con la que se cotizó en la web.
IF OBJECT_ID(N'dbo.SAPEDIDO', N'U') IS NULL
CREATE TABLE dbo.SAPEDIDO (
    NumeroD    VARCHAR(20)   NOT NULL CONSTRAINT PK_SAPEDIDO PRIMARY KEY,
    NumeroWeb  VARCHAR(36)   NOT NULL CONSTRAINT UQ_SAPEDIDO_NumeroWeb UNIQUE,
    CodClie    VARCHAR(15)   NOT NULL CONSTRAINT FK_SAPEDIDO_SACLIE REFERENCES dbo.SACLIE (CodClie),
    FechaE     DATETIME2(0)  NOT NULL CONSTRAINT DF_SAPEDIDO_FechaE DEFAULT SYSDATETIME(),
    Estado     CHAR(1)       NOT NULL CONSTRAINT DF_SAPEDIDO_Estado DEFAULT 'B',
    Monto      DECIMAL(18,2) NOT NULL,
    Tasa       DECIMAL(18,4) NOT NULL,
    Notas      VARCHAR(500)  NULL,
    CONSTRAINT CK_SAPEDIDO_Estado CHECK (Estado IN ('B'))  -- este sandbox solo admite borradores
);
GO

-- Renglones del borrador.
IF OBJECT_ID(N'dbo.SAITEMPED', N'U') IS NULL
CREATE TABLE dbo.SAITEMPED (
    NumeroD    VARCHAR(20)   NOT NULL CONSTRAINT FK_SAITEMPED_SAPEDIDO REFERENCES dbo.SAPEDIDO (NumeroD),
    NroLinea   INT           NOT NULL,
    CodProd    VARCHAR(15)   NOT NULL CONSTRAINT FK_SAITEMPED_SAPROD REFERENCES dbo.SAPROD (CodProd),
    Cantidad   DECIMAL(18,3) NOT NULL,
    Precio     DECIMAL(18,4) NOT NULL,
    TotalItem  DECIMAL(18,2) NOT NULL,
    CONSTRAINT PK_SAITEMPED PRIMARY KEY (NumeroD, NroLinea)
);
GO
