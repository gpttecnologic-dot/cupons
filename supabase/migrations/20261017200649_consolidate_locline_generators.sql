DO $$
DECLARE
  v_company_id uuid;
  v_variants jsonb;
BEGIN
  SELECT id INTO v_company_id FROM public.companies WHERE lower(name) = 'locline' LIMIT 1;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Empresa Locline não encontrada';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', gen_random_uuid(),
      'capacity_kva', capacity_kva,
      'label', label,
      'setup', 0,
      'recurring', 0,
      'active', true
    ) ORDER BY sort_order
  ) INTO v_variants
  FROM (VALUES
      ('100 kVA',100,1),
      ('110 kVA',110,2),
      ('125 kVA',125,3),
      ('150 kVA',150,4),
      ('180 kVA',180,5),
      ('200 kVA',200,6),
      ('220 kVA',220,7),
      ('250 kVA',250,8),
      ('275 kVA',275,9),
      ('300 kVA',300,10),
      ('330 kVA',330,11),
      ('350 kVA',350,12),
      ('400 kVA',400,13),
      ('450 kVA',450,14),
      ('500 kVA',500,15),
      ('550 kVA',550,16),
      ('600 kVA',600,17),
      ('625 kVA',625,18),
      ('630 kVA',630,19),
      ('700 kVA',700,20),
      ('750 kVA',750,21),
      ('800 kVA',800,22),
      ('900 kVA',900,23),
      ('1.000 kVA',1000,24),
      ('1.100 kVA',1100,25),
      ('1.250 kVA',1250,26),
      ('1.500 kVA',1500,27),
      ('1.750 kVA',1750,28),
      ('2.000 kVA',2000,29),
      ('2.250 kVA',2250,30),
      ('2.500 kVA',2500,31),
      ('2.800 kVA',2800,32),
      ('3.250 kVA',3250,33),
      ('3.438 kVA',3438,34)
  ) AS capacities(label,capacity_kva,sort_order);

  UPDATE public.products
  SET active=true,
      category='Máquinas e Equipamentos Industriais',
      description='Gerador industrial com potência e acessórios selecionáveis na proposta.',
      variants=v_variants,
      accessories='[]'::jsonb,
      default_setup=0,
      default_recurring=0,
      max_discount_percent=0,
      recurring_period='monthly',
      updated_at=now()
  WHERE company_id=v_company_id AND lower(name)='gerador';

  IF NOT FOUND THEN
    INSERT INTO public.products
      (name,category,description,active,default_setup,default_recurring,recurring_period,uses_coupons,partner_visibility,company_id,max_discount_percent,variants,accessories)
    VALUES
      ('Gerador','Máquinas e Equipamentos Industriais',
       'Gerador industrial com potência e acessórios selecionáveis na proposta.',
       true,0,0,'monthly',false,false,v_company_id,0,v_variants,'[]'::jsonb);
  END IF;

  DELETE FROM public.products p
  WHERE p.company_id=v_company_id
    AND p.name IN (SELECT 'Gerador ' || label FROM (VALUES
      ('100 kVA',100,1),
      ('110 kVA',110,2),
      ('125 kVA',125,3),
      ('150 kVA',150,4),
      ('180 kVA',180,5),
      ('200 kVA',200,6),
      ('220 kVA',220,7),
      ('250 kVA',250,8),
      ('275 kVA',275,9),
      ('300 kVA',300,10),
      ('330 kVA',330,11),
      ('350 kVA',350,12),
      ('400 kVA',400,13),
      ('450 kVA',450,14),
      ('500 kVA',500,15),
      ('550 kVA',550,16),
      ('600 kVA',600,17),
      ('625 kVA',625,18),
      ('630 kVA',630,19),
      ('700 kVA',700,20),
      ('750 kVA',750,21),
      ('800 kVA',800,22),
      ('900 kVA',900,23),
      ('1.000 kVA',1000,24),
      ('1.100 kVA',1100,25),
      ('1.250 kVA',1250,26),
      ('1.500 kVA',1500,27),
      ('1.750 kVA',1750,28),
      ('2.000 kVA',2000,29),
      ('2.250 kVA',2250,30),
      ('2.500 kVA',2500,31),
      ('2.800 kVA',2800,32),
      ('3.250 kVA',3250,33),
      ('3.438 kVA',3438,34)
    ) AS capacities(label,capacity_kva,sort_order))
    AND NOT EXISTS (SELECT 1 FROM public.crm_deal_company_products dcp WHERE dcp.product_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM public.crm_proposals cp WHERE cp.product_id=p.id);
END $$;

