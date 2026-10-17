ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS max_discount_percent numeric(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_max_discount_percent_check'
      AND conrelid = 'public.products'::regclass
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_max_discount_percent_check
      CHECK (max_discount_percent >= 0 AND max_discount_percent <= 100);
  END IF;
END $$;

ALTER TABLE public.crm_proposals
  ADD COLUMN IF NOT EXISTS items_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;
