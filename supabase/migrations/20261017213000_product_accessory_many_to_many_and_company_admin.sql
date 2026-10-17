BEGIN;

CREATE TABLE IF NOT EXISTS public.product_accessory_links (
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  accessory_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, accessory_id),
  CONSTRAINT product_accessory_links_not_self CHECK (product_id <> accessory_id)
);

CREATE INDEX IF NOT EXISTS product_accessory_links_accessory_idx
  ON public.product_accessory_links(accessory_id);
CREATE INDEX IF NOT EXISTS product_accessory_links_company_idx
  ON public.product_accessory_links(company_id);

INSERT INTO public.product_accessory_links(product_id, accessory_id, company_id)
SELECT parent_product_id, id, company_id
FROM public.products
WHERE product_type = 'accessory' AND parent_product_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.validate_product_accessory_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  product_company uuid;
  product_kind text;
  accessory_company uuid;
  accessory_kind text;
BEGIN
  SELECT company_id, product_type INTO product_company, product_kind
  FROM public.products WHERE id = NEW.product_id;
  SELECT company_id, product_type INTO accessory_company, accessory_kind
  FROM public.products WHERE id = NEW.accessory_id;
  IF product_kind IS DISTINCT FROM 'product' OR accessory_kind IS DISTINCT FROM 'accessory' THEN
    RAISE EXCEPTION 'O vínculo deve conectar um produto a um acessório';
  END IF;
  IF NEW.company_id IS DISTINCT FROM product_company OR product_company IS DISTINCT FROM accessory_company THEN
    RAISE EXCEPTION 'Produto e acessório devem pertencer à mesma empresa';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_product_accessory_link_trigger ON public.product_accessory_links;
CREATE TRIGGER validate_product_accessory_link_trigger
  BEFORE INSERT OR UPDATE ON public.product_accessory_links
  FOR EACH ROW EXECUTE FUNCTION public.validate_product_accessory_link();

ALTER TABLE public.product_accessory_links ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_accessory_links TO authenticated;
DROP POLICY IF EXISTS product_accessory_links_read_authenticated ON public.product_accessory_links;
CREATE POLICY product_accessory_links_read_authenticated ON public.product_accessory_links
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS product_accessory_links_manage_company ON public.product_accessory_links;
CREATE POLICY product_accessory_links_manage_company ON public.product_accessory_links
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = auth.uid())
    OR (
      EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = auth.uid() AND u.company_id = product_accessory_links.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = auth.uid())
    OR (
      EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = auth.uid() AND u.company_id = product_accessory_links.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = auth.uid())
    )
  );

DROP POLICY IF EXISTS products_master_write ON public.products;
CREATE POLICY products_company_admin_write ON public.products
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = auth.uid())
    OR (
      company_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = auth.uid() AND u.company_id = products.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.system_admins s WHERE s.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.crm_admins a WHERE a.user_id = auth.uid())
    OR (
      company_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.user_company_access u WHERE u.user_id = auth.uid() AND u.company_id = products.company_id)
      AND NOT EXISTS (SELECT 1 FROM public.crm_readonly_consultants r WHERE r.user_id = auth.uid())
    )
  );

COMMIT;