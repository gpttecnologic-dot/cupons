// supabase/functions/send-coupon-email/index.ts
// Deploy: supabase functions deploy send-coupon-email
// Depende de supabase/functions/_shared/mailer.ts (ver arquivo à parte) —
// copie ele pra essa pasta antes de dar deploy.
//
// Body aceito:
//   { test_email: 'alguem@exemplo.com' }               -> só testa a config
//                                                          de e-mail (usado
//                                                          pelo botão "Enviar
//                                                          e-mail de teste"
//                                                          da aba Servidor
//                                                          SMTP), não grava
//                                                          nada em events.
//   { user_id, coupon_id }                              -> compatibilidade
//                                                          antiga (1 link)
//   { user_id, coupon_ids: [...] }                       -> vários links num
//                                                          único e-mail
//   { user_id, coupon_id | coupon_ids, template_key }    -> usa um modelo
//                                                          específico da
//                                                          tabela
//                                                          email_templates
//                                                          (ex:
//                                                          'signup_thank_you',
//                                                          'coupon_reminder').
//                                                          Se omitido ou não
//                                                          encontrado (ou
//                                                          inativo), cai no
//                                                          template legado
//                                                          guardado em
//                                                          `settings`.
//
// Tags suportadas no assunto/corpo do modelo:
//   {nome} {nome_completo} {link} {links}
//
// Se o modelo (email_templates) tiver pdf_url preenchido, o PDF é baixado e
// anexado ao e-mail.
//
// O envio em si (SMTP configurado na aba "Servidor SMTP", com fallback pro
// Resend se só houver email_api_key) é feito pelo módulo _shared/mailer.ts.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendMail, settingsToConfig } from '../_shared/mailer.ts'

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

// Baixa um PDF público e devolve o base64 pronto pro attachment.
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
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const body = await req.json()
    const { test_email, user_id, coupon_id, coupon_ids, template_key } = body

    const { data: settingsRows } = await supabase.from('settings').select('key, value')
    const cfg = settingsToConfig(settingsRows)

    // ── MODO TESTE: só valida a configuração de e-mail, sem usuário/cupom ──
    if (test_email) {
      const result = await sendMail(cfg, {
        to: test_email,
        subject: 'Teste de configuração de e-mail',
        html: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#333">✅ Se você recebeu este e-mail, a configuração de envio está funcionando.</div>',
        text: 'Se você recebeu este e-mail, a configuração de envio está funcionando.',
      })
      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: result.error }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const ids: string[] = Array.isArray(coupon_ids) && coupon_ids.length
      ? coupon_ids
      : (coupon_id ? [coupon_id] : [])

    if (!user_id || !ids.length) {
      return new Response(
        JSON.stringify({ error: 'user_id e coupon_id/coupon_ids são obrigatórios.' }),
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
    // legado (settings.email_subject/email_template) — assim quem ainda não
    // rodou a migração de email_templates não quebra.
    let subjectTpl = cfg.email_subject as string || 'Seu link exclusivo chegou!'
    let bodyTpl    = cfg.email_template as string || 'Olá {nome}! Seu link: {link}'
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

    const subject  = renderTemplate(subjectTpl, vars)
    const body_    = renderTemplate(bodyTpl, vars)
    const htmlBody = toHtml(body_)

    const attachments: { filename: string; content: string }[] = []
    if (pdfUrl) {
      const b64 = await fetchPdfAsBase64(pdfUrl)
      if (b64) attachments.push({ filename: pdfFilename, content: b64 })
    }

    const result = await sendMail(cfg, {
      to: user.email,
      subject,
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#333">${htmlBody}</div>`,
      text: body_,
      attachments,
    })

    const couponIdForLog = ids[0]

    if (!result.ok) {
      await supabase.from('events').insert({
        users_id:   user_id,
        coupons_id: couponIdForLog,
        event_type: 'email_error',
        metadata:   JSON.stringify({ error: result.error, template_key: resolvedKey, coupon_ids: ids }),
      })
      return new Response(
        JSON.stringify({ error: result.error }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    await supabase.from('events').insert({
      users_id:   user_id,
      coupons_id: couponIdForLog,
      event_type: 'email_sent',
      metadata:   JSON.stringify({ id: result.id || null, to: user.email, template_key: resolvedKey, coupon_ids: ids }),
    })

    return new Response(
      JSON.stringify({ success: true, id: result.id || null }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
