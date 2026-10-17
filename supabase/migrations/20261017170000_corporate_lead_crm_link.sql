ALTER TABLE public.corporate_leads
  ADD COLUMN IF NOT EXISTS crm_deal_company_id uuid
    REFERENCES public.crm_deal_companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS corporate_leads_crm_deal_company_id_idx
  ON public.corporate_leads (crm_deal_company_id)
  WHERE crm_deal_company_id IS NOT NULL;
