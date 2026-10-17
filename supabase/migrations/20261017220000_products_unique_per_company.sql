ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS products_company_name_key ON public.products (company_id, lower(btrim(name))) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_global_name_key ON public.products (lower(btrim(name))) WHERE company_id IS NULL;
