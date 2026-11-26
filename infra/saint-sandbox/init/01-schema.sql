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
