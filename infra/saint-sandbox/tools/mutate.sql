-- Simula actividad del ERP: cambia precio y stock de productos concretos y el saldo de un cliente.
-- Cada ejecución aplica el mismo cambio otra vez (acumulativo). SAPROD.Existen se mantiene igual a la suma de SAEXIS.
USE SAINT_DEMO;
GO
SET NOCOUNT ON;

-- 1) Sube 10 % el precio 1 de P00001 a P00005.
UPDATE dbo.SAPROD SET Precio1 = ROUND(Precio1 * 1.10, 4)
WHERE CodProd IN ('P00001','P00002','P00003','P00004','P00005');

-- 2) Venta simulada: descuenta 5 unidades en el depósito 001 de P00006 a P00010 (sin bajar de 0).
UPDATE dbo.SAEXIS SET Existen = CASE WHEN Existen >= 5 THEN Existen - 5 ELSE 0 END
WHERE CodUbic = '001' AND CodProd IN ('P00006','P00007','P00008','P00009','P00010');

-- 3) Reposición: suma 100 unidades en el depósito 001 de P00011 y P00012.
UPDATE dbo.SAEXIS SET Existen = Existen + 100
WHERE CodUbic = '001' AND CodProd IN ('P00011','P00012');

-- 4) Recalcula la existencia total de los productos tocados.
UPDATE p SET Existen = (SELECT SUM(e.Existen) FROM dbo.SAEXIS e WHERE e.CodProd = p.CodProd)
FROM dbo.SAPROD p
WHERE p.CodProd IN ('P00006','P00007','P00008','P00009','P00010','P00011','P00012');

-- 5) El cliente C00001 compra a crédito: sube su saldo 50 USD.
UPDATE dbo.SACLIE SET Saldo = Saldo + 50 WHERE CodClie = 'C00001';
GO
