import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const render = (s: string, v: Record<string, string>) =>
  Object.entries(v).reduce((out, [key, value]) => out.split('{{' + key + '}}').join(value || ''), s || '')
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const auth = req.headers.get('Authorization') || ''
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'Não autenticado' }, 401)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: readonly } = await admin.from('crm_readonly_consultants').select('user_id').eq('user_id', user.id).maybeSingle()
  if (readonly) return json({ error: 'Consultor possui acesso somente de leitura' }, 403)

  try {
    const {
      deal_company_id, product_id, product_ids = [], items = [],
      proposal_type = 'client', template_id, recipient_email,
    } = await req.json()

    const { data: dc } = await userClient
      .from('crm_deal_companies')
      .select('id,deal_id,company_id,owner_user_id,crm_deals(title,contact_name,contact_email,client_company_name)')
      .eq('id', deal_company_id)
      .maybeSingle()
    if (!dc) return json({ error: 'Negociação não encontrada ou sem acesso' }, 403)

    const [{ data: companyAccess, error: accessError }, { data: crmAdmin }, { data: systemAdmin }] = await Promise.all([
      admin.from('user_company_access').select('company_id').eq('user_id', user.id),
      admin.from('crm_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
      admin.from('system_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
    ])
    if (accessError) throw accessError
    const canAccessAllCompanies = !!crmAdmin || !!systemAdmin
    const allowedCompanyIds = new Set((companyAccess || []).map((row: any) => String(row.company_id)))

    const incomingItems = Array.isArray(items) && items.length
      ? items
      : (Array.isArray(product_ids) && product_ids.length ? product_ids : (product_id ? [product_id] : []))
        .map((id: string) => ({ product_id: id, quantity: 1, discount_percent: 0 }))
    if (!incomingItems.length) return json({ error: 'Selecione ao menos um produto' }, 400)

    const normalizedItems = incomingItems.map((item: any) => ({
      product_id: String(item?.product_id || ''),
      quantity: Number(item?.quantity),
      discount_percent: Number(item?.discount_percent ?? 0),
      setup_value: item?.setup_value == null ? null : Number(item.setup_value),
      recurring_value: item?.recurring_value == null ? null : Number(item.recurring_value),
      contract_months: item?.contract_months == null ? null : Number(item.contract_months),
      variant_id: item?.variant_id ? String(item.variant_id) : null,
      accessory_ids: Array.isArray(item?.accessory_ids) ? item.accessory_ids.map((id: unknown) => String(id)) : [],
    }))
    if (normalizedItems.some((item: any) => !item.product_id || !Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
      !Number.isFinite(item.discount_percent) || item.discount_percent < 0 ||
      (item.setup_value != null && (!Number.isFinite(item.setup_value) || item.setup_value < 0)) ||
      (item.recurring_value != null && (!Number.isFinite(item.recurring_value) || item.recurring_value < 0)) ||
      (item.contract_months != null && (!Number.isSafeInteger(item.contract_months) || item.contract_months < 1)) ||
      new Set(item.accessory_ids).size !== item.accessory_ids.length)) {
      return json({ error: 'Quantidade ou desconto inválido' }, 400)
    }
    const requestedIds = [...new Set(normalizedItems.map((item: any) => item.product_id))]
    if (requestedIds.length !== normalizedItems.length) return json({ error: 'Não repita o mesmo produto na proposta' }, 400)

    const [{ data: companyProducts, error: productsError }, { data: template }, { data: owner }, { data: settings }] = await Promise.all([
      admin.from('crm_deal_company_products').select('product_id,setup_value,recurring_value,products(*)')
        .eq('deal_company_id', deal_company_id).in('product_id', requestedIds),
      admin.from('crm_company_proposal_templates').select('*')
        .eq('id', template_id).eq('company_id', dc.company_id).eq('active', true).maybeSingle(),
      dc.owner_user_id
        ? admin.from('crm_profiles').select('display_name,email').eq('user_id', dc.owner_user_id).maybeSingle()
        : Promise.resolve({ data: null }),
      admin.from('settings').select('key,value'),
    ])
    if (productsError) throw productsError
    if (!template) return json({ error: 'Selecione um modelo ativo desta empresa' }, 400)
    if (!companyProducts?.length || companyProducts.length !== requestedIds.length) {
      return json({ error: 'Selecione somente produtos vinculados a esta negociação' }, 400)
    }

    const companyProductById = new Map((companyProducts as any[]).map((row) => [row.product_id, row]))
    const productOwnerIds = [...new Set((companyProducts || []).map((row: any) => String(row.products?.company_id || '')).filter(Boolean))]
    const { data: productOwners, error: ownersError } = productOwnerIds.length
      ? await admin.from('companies').select('id,name').in('id', productOwnerIds)
      : { data: [], error: null }
    if (ownersError) throw ownersError
    const productOwnerNameById = new Map((productOwners || []).map((company: any) => [String(company.id), company.name]))

    for (const item of normalizedItems as any[]) {
      const row: any = companyProductById.get(item.product_id)
      const product = row?.products
      const productCompanyId = String(product?.company_id || '')
      if (!row || !product || product.active === false ||
        (!canAccessAllCompanies && !allowedCompanyIds.has(productCompanyId))) {
        return json({ error: 'Produto inativo ou pertencente a uma empresa sem acesso para este usuário' }, 400)
      }
      const maxDiscount = Number(product.max_discount_percent || 0)
      if (item.discount_percent > maxDiscount) {
        return json({ error: 'O desconto de ' + product.name + ' excede o limite de ' + maxDiscount + '%' }, 400)
      }
      const variants = Array.isArray(product.variants) ? product.variants.filter((option: any) => option?.active !== false) : []
      const accessories = Array.isArray(product.accessories) ? product.accessories.filter((option: any) => option?.active !== false) : []
      const variant = variants.find((option: any) => String(option.id) === item.variant_id)
      if (variants.length && !variant) return json({ error: 'Selecione uma potência válida para ' + product.name }, 400)
      if (!variants.length && item.variant_id) return json({ error: 'A potência enviada não pertence ao produto ' + product.name }, 400)
      const selectedAccessories = item.accessory_ids.map((id: string) => accessories.find((option: any) => String(option.id) === id))
      if (selectedAccessories.some((option: any) => !option)) return json({ error: 'Um acessório selecionado não pertence ao produto ' + product.name }, 400)
    }
    const pricedItems = normalizedItems.map((item: any) => {
      const row: any = companyProductById.get(item.product_id)
      const product = row?.products
      const maxDiscount = Number(product.max_discount_percent || 0)
      const variants = Array.isArray(product.variants) ? product.variants.filter((option: any) => option?.active !== false) : []
      const accessories = Array.isArray(product.accessories) ? product.accessories.filter((option: any) => option?.active !== false) : []
      const variant = variants.find((option: any) => String(option.id) === item.variant_id)
      const selectedAccessories = item.accessory_ids.map((id: string) => accessories.find((option: any) => String(option.id) === id))
      const variantSetup = variant ? Number(variant.setup || 0) : Number(row.setup_value || 0)
      const variantRecurring = variant ? Number(variant.recurring || 0) : Number(row.recurring_value || 0)
      const configuredSetup = variantSetup + selectedAccessories.reduce((sum: number, option: any) => sum + Number(option.setup || 0), 0)
      const configuredRecurring = variantRecurring + selectedAccessories.reduce((sum: number, option: any) => sum + Number(option.recurring || 0), 0)
      const setupUnit = item.setup_value == null ? configuredSetup : item.setup_value
      const recurringUnit = item.recurring_value == null ? configuredRecurring : item.recurring_value
      const contractMonths = item.contract_months == null ? 12 : item.contract_months
      if (!Number.isFinite(setupUnit) || setupUnit < 0 || !Number.isFinite(recurringUnit) || recurringUnit < 0) {
        throw new Error('Valores inválidos cadastrados para ' + product.name)
      }
      const factor = 1 - item.discount_percent / 100
      const ownerName = productOwnerNameById.get(String(product.company_id))
      const belongsToAnotherCompany = String(product.company_id) !== String(dc.company_id)
      const displayName = product.name + (variant ? ' (' + variant.label + ')' : '') +
        (belongsToAnotherCompany && ownerName ? ' — ' + ownerName : '')
      return {
        product_id: item.product_id,
        product_name: displayName || 'Produto',
        variant_id: variant?.id || null,
        variant_label: variant?.label || null,
        accessories: selectedAccessories.map((option: any) => ({
          id: option.id, label: option.label,
          setup_unit: Number(option.setup || 0), recurring_unit: Number(option.recurring || 0),
        })),
        quantity: item.quantity,
        contract_months: contractMonths,
        discount_percent: item.discount_percent,
        max_discount_percent: maxDiscount,
        setup_unit: setupUnit,
        recurring_unit: recurringUnit,
        setup_total: Number((setupUnit * item.quantity * factor).toFixed(2)),
        recurring_total: Number((recurringUnit * item.quantity * factor).toFixed(2)),
        recurring_period: product.recurring_period || null,
      }
    })

    const to = recipient_email || (dc as any).crm_deals?.contact_email
    if (!to) return json({ error: 'Destinatário sem e-mail' }, 400)
    const money = (n: number) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    const totalSetup = pricedItems.reduce((sum: number, item: any) => sum + item.setup_total, 0)
    const totalRecurring = pricedItems.reduce((sum: number, item: any) => sum + item.recurring_total, 0)
    const productNames = pricedItems.map((item: any) => item.product_name)
    const productDetails = pricedItems.map((item: any) =>
      item.product_name + (item.accessories.length ? ' | Acessórios: ' + item.accessories.map((option: any) => option.label).join(', ') : '') +
      ' — Quantidade: ' + item.quantity + ' | Contrato: ' + item.contract_months + ' meses | Desconto: ' + item.discount_percent + '% | Setup unitário: ' +
      money(item.setup_unit) + ' × ' + item.quantity + ' = ' + money(item.setup_total) + ' | Recorrência: ' +
      money(item.recurring_unit) + ' × ' + item.quantity + ' = ' + money(item.recurring_total)
    ).join('\\n')

    const vars = {
      empresa: (dc as any).crm_deals?.client_company_name || (dc as any).crm_deals?.title || '',
      contato: (dc as any).crm_deals?.contact_name || '',
      produto: productNames.join(', '),
      produtos: productNames.join(', '),
      produtos_detalhes: productDetails,
      setup: money(totalSetup),
      setup_total: money(totalSetup),
      mensal: money(totalRecurring),
      recorrencia: money(totalRecurring),
      prazo_contrato: [...new Set(pricedItems.map((item: any) => item.contract_months))].length === 1
        ? [...new Set(pricedItems.map((item: any) => item.contract_months))][0] + ' meses'
        : 'Conforme prazo de cada produto',
      responsavel_nome: owner?.display_name || '',
      responsavel_email: owner?.email || '',
    }
    const subject = render(template.subject, vars)
    const body = render(template.body, vars)

    const cfg: Record<string, string> = {}
    ;(settings || []).forEach((setting: any) => { cfg[setting.key] = setting.value })
    const { data: mail } = await admin.from('crm_company_proposal_mail').select('*')
      .eq('company_id', dc.company_id).maybeSingle()
    if (mail?.mode === 'own') {
      if (!mail.host || !mail.sender_email || !mail.password_encrypted) throw new Error('SMTP próprio incompleto')
      const raw = Uint8Array.from(atob(mail.password_encrypted), (char) => char.charCodeAt(0))
      const seed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!))
      const key = await crypto.subtle.importKey('raw', seed, 'AES-GCM', false, ['decrypt'])
      const password = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12)))
      Object.assign(cfg, {
        smtp_host: mail.host, smtp_port: String(mail.port), smtp_user: mail.username,
        smtp_password: password, smtp_secure: mail.secure, email_from: mail.sender_email,
        email_from_name: mail.sender_name || '',
      })
    }

    let ok = false, msgId = '', err = ''
    if (cfg.smtp_host) {
      const client = new SMTPClient({
        connection: {
          hostname: cfg.smtp_host, port: parseInt(cfg.smtp_port || '587'),
          tls: (cfg.smtp_secure || 'starttls').toLowerCase() === 'ssl',
          auth: cfg.smtp_user ? { username: cfg.smtp_user, password: cfg.smtp_password || '' } : undefined,
        },
      })
      try {
        await client.send({
          from: (cfg.email_from_name || '12IA') + ' <' + (cfg.email_from || 'contato@12ia.com.br') + '>',
          to, subject,
          html: '<div style="font-family:Arial,sans-serif;line-height:1.6">' + body.replace(/\\n/g, '<br>') + '</div>',
          content: body,
        })
        await client.close()
        ok = true
      } catch (e) {
        err = String(e)
        try { await client.close() } catch { /* already closed */ }
      }
    } else if (cfg.email_api_key) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.email_api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: (cfg.email_from_name || '12IA') + ' <' + (cfg.email_from || 'contato@12ia.com.br') + '>',
          to: [to], subject, html: body.replace(/\\n/g, '<br>'), text: body,
        }),
      })
      const result = await response.json()
      ok = response.ok
      msgId = result.id || ''
      if (!ok) err = JSON.stringify(result)
    } else err = 'Nenhum servidor de e-mail configurado'

    const firstProduct = (companyProducts as any[]).find((row) => row.product_id === pricedItems[0]?.product_id)?.products
    const { data: log, error: logError } = await admin.from('crm_proposals').insert({
      deal_company_id,
      product_id: pricedItems[0]?.product_id || null,
      proposal_type,
      setup_value: Number(totalSetup.toFixed(2)),
      recurring_value: Number(totalRecurring.toFixed(2)),
      recurring_period: firstProduct?.recurring_period || null,
      template_id: null,
      company_template_id: template_id,
      recipient_email: to,
      responsible_user_id: dc.owner_user_id,
      executed_by_user_id: user.id,
      subject_snapshot: subject,
      body_snapshot: body,
      items_snapshot: pricedItems,
      status: ok ? 'sent' : 'error',
      provider_message_id: msgId || null,
      error_message: err || null,
      sent_at: ok ? new Date().toISOString() : null,
    }).select('id').single()
    if (logError) throw logError

    return json({ success: ok, proposal_id: log?.id, error: err || null })
  } catch (error) {
    return json({ error: String(error) }, 500)
  }
})

