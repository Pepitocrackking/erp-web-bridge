-- Vacía las tablas del sandbox. Después, saint-init vuelve a cargar el seed original.
USE SAINT_DEMO;
GO
DELETE FROM dbo.SAEXIS;
DELETE FROM dbo.SAPROD;
DELETE FROM dbo.SACLIE;
DELETE FROM dbo.SADEPO;
DELETE FROM dbo.SAINSTA;
GO
