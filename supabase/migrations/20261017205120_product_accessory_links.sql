BEGIN;
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS product_type text NOT NULL DEFAULT 'product',
  ADD COLUMN IF NOT EXISTS parent_product_id uuid REFERENCES public.products(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_product_type_check' AND conrelid = 'public.products'::regclass) THEN
    ALTER TABLE public.products ADD CONSTRAINT products_product_type_check CHECK (product_type IN ('product', 'accessory'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_parent_type_check' AND conrelid = 'public.products'::regclass) THEN
    ALTER TABLE public.products ADD CONSTRAINT products_parent_type_check CHECK (
      (product_type = 'product' AND parent_product_id IS NULL) OR
      (product_type = 'accessory' AND parent_product_id IS NOT NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS products_parent_product_id_idx ON public.products(parent_product_id);

CREATE OR REPLACE FUNCTION public.validate_product_parent_company()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_company_id uuid;
  parent_type text;
BEGIN
  IF NEW.product_type = 'accessory' THEN
    SELECT company_id, product_type INTO parent_company_id, parent_type
      FROM public.products WHERE id = NEW.parent_product_id;
    IF parent_company_id IS NULL OR parent_type <> 'product' THEN
      RAISE EXCEPTION 'Acessório deve ser vinculado a um produto válido';
    END IF;
    IF parent_company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'Acessório e produto devem pertencer à mesma empresa';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.products child WHERE child.parent_product_id = NEW.id AND child.company_id IS DISTINCT FROM NEW.company_id) THEN
    RAISE EXCEPTION 'Produto possui acessórios de outra empresa';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_product_parent_company_trigger ON public.products;
CREATE TRIGGER validate_product_parent_company_trigger
  BEFORE INSERT OR UPDATE OF company_id, product_type, parent_product_id
  ON public.products FOR EACH ROW EXECUTE FUNCTION public.validate_product_parent_company();
COMMIT;