import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  const auth = req.headers.get('Authorization') || ''
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'Não autenticado' }, 401)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const { data: readonly } = await admin.from('crm_readonly_consultants').select('user_id').eq('user_id', user.id).maybeSingle()
    if (readonly) return json({ error: 'Usuário possui acesso somente de leitura' }, 403)
    const { corporate_lead_id } = await req.json()
    if (!corporate_lead_id || typeof corporate_lead_id !== 'string') return json({ error: 'Pedido corporativo inválido' }, 400)

    // This user-scoped read enforces the existing corporate tab policy.
    const { data: lead, error: leadError } = await userClient.from('corporate_leads')
      .select('id,name,email,phone,referral_id,quantidade_licencas,crm_deal_company_id')
      .eq('id', corporate_lead_id).maybeSingle()
    if (leadError || !lead) return json({ error: 'Pedido não encontrado ou sem acesso à aba Corporativo' }, 403)
    if (lead.crm_deal_company_id) return json({ success: true, already_sent: true, crm_deal_company_id: lead.crm_deal_company_id })

    const [{ data: company }, { data: referral }] = await Promise.all([
      admin.from('companies').select('id,name').ilike('name', '12ia').maybeSingle(),
      lead.referral_id ? admin.from('referrals').select('name').eq('id', lead.referral_id).maybeSingle() : Promise.resolve({ data: null }),
    ])
    if (!company) return json({ error: 'Empresa 12IA não encontrada no CRM' }, 500)
    const { data: stages } = await admin.from('crm_stages').select('id,name').eq('company_id', company.id).order('position')
    const stage = stages?.find((item: any) => item.name === 'Nutrição de Leads (início do funil)') || stages?.[0]
    if (!stage) return json({ error: 'O funil da 12IA não possui etapas cadastradas' }, 500)

    const dealId = crypto.randomUUID()
    const { error: dealError } = await admin.from('crm_deals').insert({
      id: dealId,
      title: `Pedido corporativo — ${lead.name}`,
      contact_name: lead.name,
      contact_email: lead.email,
      contact_phone: lead.phone,
      referral_id: lead.referral_id,
      notes: `Enviado da aba Corporativo. Quantidade solicitada: ${lead.quantidade_licencas} licenças.${referral?.name ? ` Parceiro de origem: ${referral.name}.` : ''}`,
      created_by: user.id,
    })
    if (dealError) throw dealError

    const dealCompanyId = crypto.randomUUID()
    const { error: linkError } = await admin.from('crm_deal_companies').insert({
      id: dealCompanyId,
      deal_id: dealId,
      company_id: company.id,
      stage_id: stage.id,
      position: 0,
    })
    if (linkError) {
      await admin.from('crm_deals').delete().eq('id', dealId)
      throw linkError
    }

    // Claim the source lead exactly once. If a second click raced, remove
    // the unused CRM rows and return the winner's link.
    const { data: claimed, error: claimError } = await admin.from('corporate_leads')
      .update({ crm_deal_company_id: dealCompanyId })
      .eq('id', lead.id).is('crm_deal_company_id', null).select('id').maybeSingle()
    if (claimError || !claimed) {
      await admin.from('crm_deal_companies').delete().eq('id', dealCompanyId)
      await admin.from('crm_deals').delete().eq('id', dealId)
      const { data: current } = await admin.from('corporate_leads').select('crm_deal_company_id').eq('id', lead.id).maybeSingle()
      if (current?.crm_deal_company_id) return json({ success: true, already_sent: true, crm_deal_company_id: current.crm_deal_company_id })
      throw claimError || new Error('Não foi possível vincular o pedido ao CRM')
    }

    return json({ success: true, crm_deal_company_id: dealCompanyId, company_name: company.name, stage_name: stage.name })
  } catch (error) {
    return json({ error: String(error) }, 500)
  }
})
