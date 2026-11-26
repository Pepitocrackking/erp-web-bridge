-- Catálogo web (Fase 6, tarea 6.1).
--
-- La web lista las categorías del catálogo sin traerse todos los productos: PostgREST no tiene
-- DISTINCT, así que se expone una vista agregada.
--
-- `security_invoker = true` hace que la vista se evalúe con los permisos y las políticas RLS de
-- quien consulta (no las del dueño), de modo que cada usuario cuenta solo los productos que ya
-- puede leer en `products`: no hay filtración entre organizaciones. Además se filtra por
-- `is_active`, porque el personal puede leer productos inactivos pero el catálogo no los muestra.

CREATE VIEW public.catalog_categories
  WITH (security_invoker = true) AS
SELECT org_id, category, count(*)::int AS product_count
  FROM public.products
 WHERE is_active AND category IS NOT NULL AND btrim(category) <> ''
 GROUP BY org_id, category;

-- Las vistas nuevas nacen sin permisos para anon/authenticated (ALTER DEFAULT PRIVILEGES de la
-- migración de RLS): se concede solo lectura a usuarios autenticados.
GRANT SELECT ON public.catalog_categories TO authenticated;
