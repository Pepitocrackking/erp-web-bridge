-- Login SQL DEDICADO del agente (Fase 7, tarea 7.3): segunda capa de la garantía de "cero riesgo
-- contable". El agente debe conectarse con este login, no con sa. Aunque el código del agente
-- tuviera un error, SQL Server rechaza cualquier escritura fuera de los borradores.
--
--   - LEE: productos, existencias, depósitos, categorías y clientes (lo que sincroniza).
--   - ESCRIBE: solo INSERT en las dos tablas del borrador y el correlativo (no UPDATE ni DELETE).
--   - NO TOCA las tablas fiscales (SELECT, INSERT, UPDATE y DELETE denegados).
--
-- Contraseña de DESARROLLO, solo para este sandbox con datos ficticios. En un Saint real, el
-- administrador crea su propio login con estos mismos permisos y una contraseña propia.
-- Idempotente.

USE master;
GO
IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'erp_agent')
    CREATE LOGIN erp_agent WITH PASSWORD = N'Agent_Demo_2026!', CHECK_POLICY = OFF;
GO

USE SAINT_DEMO;
GO
IF DATABASE_PRINCIPAL_ID(N'erp_agent') IS NULL
    CREATE USER erp_agent FOR LOGIN erp_agent;
GO

-- Lectura de lo que sincroniza.
GRANT SELECT ON dbo.SAPROD  TO erp_agent;
GRANT SELECT ON dbo.SAEXIS  TO erp_agent;
GRANT SELECT ON dbo.SADEPO  TO erp_agent;
GRANT SELECT ON dbo.SAINSTA TO erp_agent;
GRANT SELECT ON dbo.SACLIE  TO erp_agent;

-- Escritura: solo borradores, solo INSERT. Leer lo escrito es necesario para detectar el reintento.
GRANT SELECT, INSERT ON dbo.SAPEDIDO  TO erp_agent;
GRANT SELECT, INSERT ON dbo.SAITEMPED TO erp_agent;
GRANT UPDATE ON OBJECT::dbo.SQ_SAPEDIDO_WEB TO erp_agent; -- NEXT VALUE FOR exige UPDATE sobre la secuencia
GO

-- Lo contable, vedado de forma explícita (un DENY gana a cualquier GRANT, también el de un rol).
DENY SELECT, INSERT, UPDATE, DELETE ON dbo.SAFACT    TO erp_agent;
DENY SELECT, INSERT, UPDATE, DELETE ON dbo.SAITEMFAC TO erp_agent;
DENY SELECT, INSERT, UPDATE, DELETE ON dbo.SAACXC    TO erp_agent;

-- Los datos maestros se leen, nunca se modifican.
DENY INSERT, UPDATE, DELETE ON dbo.SAPROD  TO erp_agent;
DENY INSERT, UPDATE, DELETE ON dbo.SAEXIS  TO erp_agent;
DENY INSERT, UPDATE, DELETE ON dbo.SADEPO  TO erp_agent;
DENY INSERT, UPDATE, DELETE ON dbo.SAINSTA TO erp_agent;
DENY INSERT, UPDATE, DELETE ON dbo.SACLIE  TO erp_agent;

-- Un borrador, una vez escrito, no se edita ni se borra desde el agente.
DENY UPDATE, DELETE ON dbo.SAPEDIDO  TO erp_agent;
DENY UPDATE, DELETE ON dbo.SAITEMPED TO erp_agent;
GO
