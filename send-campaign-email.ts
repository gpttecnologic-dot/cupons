// supabase/functions/send-campaign-email/index.ts
// Deploy: supabase functions deploy send-campaign-email
// Depende de supabase/functions/_shared/mailer.ts — copie ele antes do deploy.
//
// Dispara uma campanha de e-mail personalizada para uma lista de usuários.
// O admin (admin.html) resolve a segmentação (indicação / status do cupom /
// período) no próprio client e manda só a lista final de user_id — essa
// função cuida de personalizar cada mensagem, enviar (SMTP configurado na
// aba "Servidor SMTP", com fallback pro Resend se só houver email_api_key) e
// registrar o resultado: por usuário em `events` (event_type
// 'campaign_email_sent' / 'campaign_email_error') e o resumo agregado em
// `email_campaign_log`.
//
// Body: { template_id: uuid, user_ids: string[], filters?: object }
//
// Tags suportadas (mesmas do send-coupon-email):
//   {nome} {nome_completo} {link} {links}
// {link}/{links} usam os cupons vinculados a cada usuário (coupons.users_id).
// Usuário sem cupom vinculado recebe {link}/{links} vazios.
//
// Limite de 300 destinatários por chamada (a function tem timeout; o admin
// já divide listas maiores em lotes e chama de novo). Manda um pequeno
// intervalo entre envios pra não estourar rate limit do servidor SMTP.

// IMPORTANTE: depende de supabase/functions/_shared/mailer.ts (mesma pasta,
// um nível acima) já com o tratamento de erro SMTP assíncrono — veja o
// comentário sobre 'unhandledrejection' nesse arquivo antes de reimplantar.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendMail, settingsToConfig } from '../_shared/mailer.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_RECIPIENTS_PER_CALL = 300
const SEND_DELAY_MS = 300

function firstName(fullName: string) {
  return (fullName || '').trim().split(/\s+/)[0] || ''
}
function renderTemplate(str: string, vars: Record<string, string>) {
  let out = str || ''
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v ?? '')
  return out
}
function toHtml(body: string) {
  return body.replace(/\*(.*?)\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')
}
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
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

    const { template_id, user_ids, filters } = await req.json()

    if (!template_id || !Array.isArray(user_ids) || !user_ids.length) {
      return new Response(
        JSON.stringify({ error: 'template_id e user_ids (array não vazio) são obrigatórios.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    if (user_ids.length > MAX_RECIPIENTS_PER_CALL) {
      return new Response(
        JSON.stringify({ error: `Máximo de ${MAX_RECIPIENTS_PER_CALL} destinatários por disparo. Divida em lotes.` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { data: settingsRows } = await supabase.from('settings').select('key, value')
    const cfg = settingsToConfig(settingsRows)

    const { data: template } = await supabase
      .from('email_templates')
      .select('id, key, subject, body, pdf_url, pdf_filename')
      .eq('id', template_id)
      .single()

    if (!template) {
      return new Response(
        JSON.stringify({ error: 'Modelo de e-mail não encontrado.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let attachmentB64: string | null = null
    if (template.pdf_url) attachmentB64 = await fetchPdfAsBase64(template.pdf_url)

    const { data: users } = await supabase
      .from('users').select('id, name, email').in('id', user_ids)
    const { data: coupons } = await supabase
      .from('coupons').select('id, link, users_id').in('users_id', user_ids)

    const couponsByUser: Record<string, string[]> = {}
    ;(coupons || []).forEach((c: any) => {
      if (!c.users_id) return
      ;(couponsByUser[c.users_id] ||= []).push(c.link)
    })

    let sent = 0, failed = 0
    const eventsLog: any[] = []

    for (const u of (users || [])) {
      const links = couponsByUser[u.id] || []
      const vars = {
        nome: firstName(u.name),
        nome_completo: u.name,
        link: links[0] || '',
        links: links.map((l) => `• ${l}`).join('\n'),
      }
      const subject = renderTemplate(template.subject, vars)
      const body_    = renderTemplate(template.body, vars)
      const html     = toHtml(body_)

      const attachments = attachmentB64
        ? [{ filename: template.pdf_filename || 'anexo.pdf', content: attachmentB64 }]
        : []

      const result = await sendMail(cfg, {
        to: u.email,
        subject,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#333">${html}</div>`,
        text: body_,
        attachments,
      })

      if (result.ok) {
        sent++
        eventsLog.push({
          users_id: u.id, event_type: 'campaign_email_sent',
          metadata: JSON.stringify({ id: result.id || null, template_key: template.key, to: u.email }),
        })
      } else {
        failed++
        eventsLog.push({
          users_id: u.id, event_type: 'campaign_email_error',
          metadata: JSON.stringify({ error: result.error, template_key: template.key, to: u.email }),
        })
      }

      await sleep(SEND_DELAY_MS)
    }

    if (eventsLog.length) await supabase.from('events').insert(eventsLog)

    await supabase.from('email_campaign_log').insert({
      template_id: template.id,
      template_key: template.key,
      filters: filters || null,
      total_recipients: (users || []).length,
      total_sent: sent,
      total_failed: failed,
    })

    return new Response(
      JSON.stringify({ success: true, total: (users || []).length, sent, failed }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
