-- Vacía las tablas del sandbox. Después, saint-init vuelve a cargar el seed original.
USE SAINT_DEMO;
GO
-- Los borradores primero (referencian clientes y productos). Con IF por si la base es anterior a la Fase 7.
IF OBJECT_ID(N'dbo.SAITEMPED', N'U') IS NOT NULL DELETE FROM dbo.SAITEMPED;
IF OBJECT_ID(N'dbo.SAPEDIDO', N'U') IS NOT NULL DELETE FROM dbo.SAPEDIDO;
IF OBJECT_ID(N'dbo.SQ_SAPEDIDO_WEB', N'SO') IS NOT NULL ALTER SEQUENCE dbo.SQ_SAPEDIDO_WEB RESTART WITH 1;
GO
DELETE FROM dbo.SAEXIS;
DELETE FROM dbo.SAPROD;
DELETE FROM dbo.SACLIE;
DELETE FROM dbo.SADEPO;
DELETE FROM dbo.SAINSTA;
GO
