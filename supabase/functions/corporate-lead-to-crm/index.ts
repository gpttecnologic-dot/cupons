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

    const { corporate_lead_id, corporate_client_user_id } = await req.json()
    const isLead = typeof corporate_lead_id === 'string' && !!corporate_lead_id
    const isClient = typeof corporate_client_user_id === 'string' && !!corporate_client_user_id
    if (isLead === isClient) return json({ error: 'Informe um pedido ou cliente corporativo válido' }, 400)

    let source: any
    let sourceTable: 'corporate_leads' | 'users'
    let issuedLicenses = 0
    if (isLead) {
      sourceTable = 'corporate_leads'
      const { data, error } = await userClient.from('corporate_leads')
        .select('id,name,email,phone,referral_id,quantidade_licencas,crm_deal_company_id')
        .eq('id', corporate_lead_id).maybeSingle()
      if (error || !data) return json({ error: 'Pedido não encontrado ou sem acesso à aba Corporativo' }, 403)
      source = data
      issuedLicenses = Number(data.quantidade_licencas || 0)
    } else {
      sourceTable = 'users'
      const { data, error } = await userClient.from('users')
        .select('id,name,email,phone,referral_id,segmento,crm_deal_company_id')
        .eq('id', corporate_client_user_id).eq('segmento', 'corporativo').maybeSingle()
      if (error || !data) return json({ error: 'Cliente não encontrado ou sem acesso à lista Clientes Corporativos' }, 403)
      source = data
      const { count, error: countError } = await admin.from('coupons')
        .select('id', { count: 'exact', head: true })
        .eq('users_id', data.id).in('status', ['delivered', 'redeemed'])
      if (countError) throw countError
      issuedLicenses = count || 0
    }
    if (source.crm_deal_company_id) {
      return json({ success: true, already_sent: true, crm_deal_company_id: source.crm_deal_company_id })
    }

    const [{ data: company }, { data: referral }] = await Promise.all([
      admin.from('companies').select('id,name').ilike('name', '12ia').maybeSingle(),
      source.referral_id ? admin.from('referrals').select('name').eq('id', source.referral_id).maybeSingle() : Promise.resolve({ data: null }),
    ])
    if (!company) return json({ error: 'Empresa 12IA não encontrada no CRM' }, 500)
    const { data: stages } = await admin.from('crm_stages').select('id,name').eq('company_id', company.id).order('position')
    const stage = stages?.find((item: any) => item.name === 'Nutrição de Leads (início do funil)') || stages?.[0]
    if (!stage) return json({ error: 'O funil da 12IA não possui etapas cadastradas' }, 500)

    const clientTitle = isClient ? 'Cliente corporativo' : 'Pedido corporativo'
    const sourceLabel = isClient ? 'Clientes Corporativos' : 'Corporativo'
    const licenseLabel = isClient ? 'Licenças emitidas' : 'Licenças solicitadas'
    const dealId = crypto.randomUUID()
    const { error: dealError } = await admin.from('crm_deals').insert({
      id: dealId,
      title: `${clientTitle} — ${source.name}`,
      contact_name: source.name,
      contact_email: source.email,
      contact_phone: source.phone,
      referral_id: source.referral_id,
      notes: `Enviado da seção ${sourceLabel}. ${licenseLabel}: ${issuedLicenses}.${referral?.name ? ` Parceiro de origem: ${referral.name}.` : ''}`,
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

    // Claim the source row exactly once. Clean up if a second click raced.
    const { data: claimed, error: claimError } = await admin.from(sourceTable)
      .update({ crm_deal_company_id: dealCompanyId })
      .eq('id', source.id).is('crm_deal_company_id', null).select('id').maybeSingle()
    if (claimError || !claimed) {
      await admin.from('crm_deal_companies').delete().eq('id', dealCompanyId)
      await admin.from('crm_deals').delete().eq('id', dealId)
      const { data: current } = await admin.from(sourceTable).select('crm_deal_company_id').eq('id', source.id).maybeSingle()
      if (current?.crm_deal_company_id) return json({ success: true, already_sent: true, crm_deal_company_id: current.crm_deal_company_id })
      throw claimError || new Error('Não foi possível vincular o registro ao CRM')
    }

    return json({ success: true, crm_deal_company_id: dealCompanyId, company_name: company.name, stage_name: stage.name })
  } catch (error) {
    return json({ error: String(error) }, 500)
  }
})
