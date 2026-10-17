ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS crm_deal_company_id uuid
    REFERENCES public.crm_deal_companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_crm_deal_company_id_idx
  ON public.users (crm_deal_company_id)
  WHERE crm_deal_company_id IS NOT NULL;
