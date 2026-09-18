// supabase/functions/send-coupon-email/index.ts
// Deploy: supabase functions deploy send-coupon-email
//
// Body aceito:
//   { user_id, coupon_id }                             -> compatibilidade antiga (1 link)
//   { user_id, coupon_ids: [...] }                      -> vários links num único e-mail
//   { user_id, coupon_id | coupon_ids, template_key }   -> usa um modelo específico da
//                                                          tabela email_templates
//                                                          (ex: 'signup_thank_you',
//                                                          'coupon_reminder'). Se omitido
//                                                          ou não encontrado (ou inativo),
//                                                          cai no template legado guardado
//                                                          em `settings` (comportamento
//                                                          antigo desta função).
//
// Tags suportadas no assunto/corpo do modelo:
//   {nome}          -> primeiro nome do usuário
//   {nome_completo} -> nome completo
//   {link}          -> primeiro link de cupom do envio
//   {links}         -> todos os links do envio, um por linha (• link)
//
// Se o modelo (email_templates) tiver pdf_url preenchido, o PDF é baixado e
// anexado ao e-mail via Resend (attachments). pdf_url precisa ser público
// (ex: um arquivo no Supabase Storage com acesso público).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function firstName(fullName: string) {
  return (fullName || '').trim().split(/\s+/)[0] || ''
}

function renderTemplate(str: string, vars: Record<string, string>) {
  let out = str || ''
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v ?? '')
  return out
}

function toHtml(body: string) {
  return body
    .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')
}

// Baixa um PDF público e devolve o base64 pronto pro attachment do Resend.
async function fetchPdfAsBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    let binary = ''
    for (let i = 0; i < buf.byteLength; i++) binary += String.fromCharCode(buf[i])
    return btoa(binary)
  } catch {
    return null
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Cria cliente Supabase com service_role para acessar settings/templates
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { user_id, coupon_id, coupon_ids, template_key } = await req.json()

    const ids: string[] = Array.isArray(coupon_ids) && coupon_ids.length
      ? coupon_ids
      : (coupon_id ? [coupon_id] : [])

    if (!user_id || !ids.length) {
      return new Response(
        JSON.stringify({ error: 'user_id e coupon_id/coupon_ids são obrigatórios.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Configurações gerais de envio (chave Resend, remetente) continuam na
    // tabela settings — são "conta", não "modelo de mensagem".
    const { data: settingsRows } = await supabase.from('settings').select('key, value')
    const cfg: Record<string, string> = {}
    ;(settingsRows || []).forEach((r: any) => { cfg[r.key] = r.value })

    const apiKey   = cfg['email_api_key']
    const from     = cfg['email_from']      || 'contato@12ia.com.br'
    const fromName = cfg['email_from_name'] || 'Cupom GPT-Business'

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'API Key do Resend não configurada.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Busca o usuário e o(s) cupom(ns)
    const { data: user } = await supabase
      .from('users').select('name, email').eq('id', user_id).single()

    const { data: coupons } = await supabase
      .from('coupons').select('id, link').in('id', ids)

    if (!user || !coupons?.length) {
      return new Response(
        JSON.stringify({ error: 'Usuário ou cupom(ns) não encontrado(s).' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Modelo de mensagem. Prioridade: template_key pedido (ativo) > fallback
    // legado (settings.email_subject/email_template), igual ao comportamento
    // original desta função — assim quem ainda não rodou a migração de
    // email_templates não quebra.
    let subjectTpl = cfg['email_subject']  || 'Seu link exclusivo chegou!'
    let bodyTpl    = cfg['email_template'] || 'Olá {nome}! Seu link: {link}'
    let pdfUrl: string | null = null
    let pdfFilename = 'anexo.pdf'
    let resolvedKey: string | null = template_key || null

    if (template_key) {
      const { data: tpl } = await supabase
        .from('email_templates')
        .select('key, subject, body, pdf_url, pdf_filename, active')
        .eq('key', template_key)
        .eq('active', true)
        .maybeSingle()
      if (tpl) {
        subjectTpl  = tpl.subject
        bodyTpl     = tpl.body
        pdfUrl      = tpl.pdf_url || null
        pdfFilename = tpl.pdf_filename || pdfFilename
        resolvedKey = tpl.key
      }
    }

    // Monta as tags disponíveis
    const links = coupons.map((c: any) => c.link).filter(Boolean)
    const linksBlock = links.map((l: string) => `• ${l}`).join('\n')
    const vars = {
      nome: firstName(user.name),
      nome_completo: user.name,
      link: links[0] || '',
      links: linksBlock,
    }

    const subject = renderTemplate(subjectTpl, vars)
    const body     = renderTemplate(bodyTpl, vars)
    const htmlBody = toHtml(body)

    const attachments: any[] = []
    if (pdfUrl) {
      const b64 = await fetchPdfAsBase64(pdfUrl)
      if (b64) attachments.push({ filename: pdfFilename, content: b64 })
    }

    const emailPayload: any = {
      from: `${fromName} <${from}>`,
      to: [user.email],
      subject,
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#333">${htmlBody}</div>`,
      text: body,
    }
    if (attachments.length) emailPayload.attachments = attachments

    // Envia via Resend
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailPayload),
    })

    const resendData = await resendRes.json()
    const couponIdForLog = ids[0]

    if (!resendRes.ok) {
      // Registra o erro no log de eventos
      await supabase.from('events').insert({
        users_id:   user_id,
        coupons_id: couponIdForLog,
        event_type: 'email_error',
        metadata:   JSON.stringify({ error: resendData, template_key: resolvedKey, coupon_ids: ids }),
      })
      return new Response(
        JSON.stringify({ error: resendData }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Registra sucesso no log de eventos
    await supabase.from('events').insert({
      users_id:   user_id,
      coupons_id: couponIdForLog,
      event_type: 'email_sent',
      metadata:   JSON.stringify({ resend_id: resendData.id, to: user.email, template_key: resolvedKey, coupon_ids: ids }),
    })

    return new Response(
      JSON.stringify({ success: true, id: resendData.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
