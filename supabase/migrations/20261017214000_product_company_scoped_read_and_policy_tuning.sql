BEGIN;
DROP POLICY IF EXISTS products_read_authenticated ON public.products;
CREATE POLICY products_read_company_scope ON public.products FOR SELECT TO authenticated
USING (
  (select auth.uid()) IS NOT NULL
  AND (
    EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = (select auth.uid()))
    OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = (select auth.uid()))
    OR EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = (select auth.uid()) AND u.company_id = products.company_id)
  )
);
DROP POLICY IF EXISTS products_company_admin_write ON public.products;
DROP POLICY IF EXISTS products_company_admin_insert ON public.products;
DROP POLICY IF EXISTS products_company_admin_update ON public.products;
DROP POLICY IF EXISTS products_company_admin_delete ON public.products;
CREATE POLICY products_company_admin_insert ON public.products FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = (select auth.uid()))
  OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = (select auth.uid()))
  OR (company_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = (select auth.uid()) AND u.company_id = products.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = (select auth.uid())))
);
CREATE POLICY products_company_admin_update ON public.products FOR UPDATE TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = (select auth.uid()))
  OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = (select auth.uid()))
  OR (company_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = (select auth.uid()) AND u.company_id = products.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = (select auth.uid())))
)
WITH CHECK (
  EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = (select auth.uid()))
  OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = (select auth.uid()))
  OR (company_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = (select auth.uid()) AND u.company_id = products.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = (select auth.uid())))
);
CREATE POLICY products_company_admin_delete ON public.products FOR DELETE TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = (select auth.uid()))
  OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = (select auth.uid()))
  OR (company_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = (select auth.uid()) AND u.company_id = products.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = (select auth.uid())))
);

DROP POLICY IF EXISTS product_accessory_links_read_authenticated ON public.product_accessory_links;
DROP POLICY IF EXISTS product_accessory_links_read_company_scope ON public.product_accessory_links;
CREATE POLICY product_accessory_links_read_company_scope ON public.product_accessory_links FOR SELECT TO authenticated
USING (
  (select auth.uid()) IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = (select auth.uid()))
    OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = (select auth.uid()))
    OR EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = (select auth.uid()) AND u.company_id = product_accessory_links.company_id)
  )
);
DROP POLICY IF EXISTS product_accessory_links_manage_company ON public.product_accessory_links;
DROP POLICY IF EXISTS product_accessory_links_insert_company ON public.product_accessory_links;
DROP POLICY IF EXISTS product_accessory_links_update_company ON public.product_accessory_links;
DROP POLICY IF EXISTS product_accessory_links_delete_company ON public.product_accessory_links;
CREATE POLICY product_accessory_links_insert_company ON public.product_accessory_links FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = (select auth.uid()))
  OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = (select auth.uid()))
  OR (EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = (select auth.uid()) AND u.company_id = product_accessory_links.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = (select auth.uid())))
);
CREATE POLICY product_accessory_links_update_company ON public.product_accessory_links FOR UPDATE TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = (select auth.uid()))
  OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = (select auth.uid()))
  OR (EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = (select auth.uid()) AND u.company_id = product_accessory_links.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = (select auth.uid())))
)
WITH CHECK (
  EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = (select auth.uid()))
  OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = (select auth.uid()))
  OR (EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = (select auth.uid()) AND u.company_id = product_accessory_links.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = (select auth.uid())))
);
CREATE POLICY product_accessory_links_delete_company ON public.product_accessory_links FOR DELETE TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = (select auth.uid()))
  OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = (select auth.uid()))
  OR (EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = (select auth.uid()) AND u.company_id = product_accessory_links.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = (select auth.uid())))
);

CREATE OR REPLACE FUNCTION public.validate_product_accessory_link()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE product_company uuid; product_kind text; accessory_company uuid; accessory_kind text;
BEGIN
  SELECT company_id, product_type INTO product_company, product_kind FROM products WHERE id = NEW.product_id;
  SELECT company_id, product_type INTO accessory_company, accessory_kind FROM products WHERE id = NEW.accessory_id;
  IF product_kind IS DISTINCT FROM 'product' OR accessory_kind IS DISTINCT FROM 'accessory' THEN RAISE EXCEPTION 'O vínculo deve conectar um produto a um acessório'; END IF;
  IF NEW.company_id IS DISTINCT FROM product_company OR product_company IS DISTINCT FROM accessory_company THEN RAISE EXCEPTION 'Produto e acessório devem pertencer à mesma empresa'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.validate_product_parent_company()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE parent_company_id uuid; parent_type text;
BEGIN
  IF NEW.product_type = 'accessory' THEN
    SELECT company_id, product_type INTO parent_company_id, parent_type FROM products WHERE id = NEW.parent_product_id;
    IF parent_company_id IS NULL OR parent_type <> 'product' THEN RAISE EXCEPTION 'Acessório deve ser vinculado a um produto válido'; END IF;
    IF parent_company_id IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'Acessório e produto devem pertencer à mesma empresa'; END IF;
  ELSIF EXISTS (SELECT 1 FROM products child WHERE child.parent_product_id = NEW.id AND child.company_id IS DISTINCT FROM NEW.company_id) THEN
    RAISE EXCEPTION 'Produto possui acessórios de outra empresa';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.reassign_accessory_parent_before_product_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE replacement_product uuid;
BEGIN
  IF OLD.product_type = 'product' THEN
    FOR replacement_product IN
      SELECT DISTINCT link.accessory_id FROM product_accessory_links link
      JOIN products accessory ON accessory.id = link.accessory_id
      WHERE link.product_id = OLD.id AND accessory.parent_product_id = OLD.id
    LOOP
      UPDATE products accessory SET parent_product_id = (
        SELECT link2.product_id FROM product_accessory_links link2 JOIN products other_product ON other_product.id = link2.product_id
        WHERE link2.accessory_id = replacement_product AND link2.product_id <> OLD.id
        ORDER BY link2.created_at, link2.product_id LIMIT 1
      )
      WHERE accessory.id = replacement_product
        AND EXISTS (SELECT 1 FROM product_accessory_links x WHERE x.accessory_id = replacement_product AND x.product_id <> OLD.id);
    END LOOP;
  END IF;
  RETURN OLD;
END; $$;
COMMIT;