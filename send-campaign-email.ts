// send-campaign-email — deployado via Supabase Dashboard Editor
// Body: { template_id: uuid, user_ids: string[], filters?: object }
// Tags: {nome} {nome_completo} {link} {links}

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_RECIPIENTS_PER_CALL = 300
const SEND_DELAY_MS = 300

// ── MAILER (SMTP com fallback pra Resend) ───────────────────────────────────
interface MailSettings {
  smtp_host?: string
  smtp_port?: string
  smtp_user?: string
  smtp_password?: string
  smtp_secure?: string
  email_api_key?: string
  email_from?: string
  email_from_name?: string
  [k: string]: string | undefined
}
interface MailAttachment { filename: string; content: string }
interface MailMessage { to: string; subject: string; html: string; text: string; attachments?: MailAttachment[] }
interface MailResult { ok: boolean; id?: string; error?: unknown }

function settingsToConfig(rows: { key: string; value: string }[] | null): MailSettings {
  const cfg: Record<string, string> = {}
  ;(rows || []).forEach((r) => { cfg[r.key] = r.value })
  return cfg as MailSettings
}

async function sendMail(cfg: MailSettings, msg: MailMessage): Promise<MailResult> {
  if (cfg.smtp_host) return sendViaSmtp(cfg, msg)
  if (cfg.email_api_key) return sendViaResend(cfg, msg)
  return { ok: false, error: 'Nenhum servidor de e-mail configurado.' }
}

// denomailer, em erros de protocolo SMTP (ex: usuário/senha rejeitados pelo
// Gmail — "invalid cmd" na negociação), lança fora da cadeia de promises que
// o try/catch normal consegue pegar; sem tratamento isso derruba a Edge
// Function inteira (isolate reinicia no meio da resposta), o que aparece no
// navegador como um erro genérico de CORS/"Failed to fetch" escondendo o erro
// real. Por isso capturamos via 'unhandledrejection' durante o envio.
async function sendViaSmtp(cfg: MailSettings, msg: MailMessage): Promise<MailResult> {
  const from = cfg.email_from || 'contato@12ia.com.br'
  const fromName = cfg.email_from_name || 'Cupom GPT-Business'
  const port = parseInt(cfg.smtp_port || '587', 10)
  const secure = (cfg.smtp_secure || 'starttls').toLowerCase()

  const client = new SMTPClient({
    connection: {
      hostname: cfg.smtp_host as string,
      port,
      tls: secure === 'ssl',
      auth: cfg.smtp_user ? { username: cfg.smtp_user, password: cfg.smtp_password || '' } : undefined,
    },
  })

  return await new Promise<MailResult>((resolve) => {
    let settled = false
    const finish = (result: MailResult) => {
      if (settled) return
      settled = true
      // deno-lint-ignore no-explicit-any
      ;(self as any).removeEventListener?.('unhandledrejection', onUnhandled)
      resolve(result)
    }
    // deno-lint-ignore no-explicit-any
    const onUnhandled = (event: any) => {
      if (settled) return
      event.preventDefault?.()
      client.close().catch(() => {})
      finish({ ok: false, error: 'Erro SMTP (conexão/autenticação recusada pelo servidor): ' + String(event.reason ?? event) })
    }
    // deno-lint-ignore no-explicit-any
    ;(self as any).addEventListener?.('unhandledrejection', onUnhandled)

    ;(async () => {
      try {
        await client.send({
          from: `${fromName} <${from}>`,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          content: msg.text,
          attachments: (msg.attachments || []).map((a) => ({ filename: a.filename, content: a.content, encoding: 'base64' as const })),
        })
        await client.close()
        finish({ ok: true })
      } catch (err) {
        try { await client.close() } catch { /* noop */ }
        finish({ ok: false, error: String(err) })
      }
    })()
  })
}

async function sendViaResend(cfg: MailSettings, msg: MailMessage): Promise<MailResult> {
  const from = cfg.email_from || 'contato@12ia.com.br'
  const fromName = cfg.email_from_name || 'Cupom GPT-Business'
  const payload: Record<string, unknown> = {
    from: `${fromName} <${from}>`, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text,
  }
  if (msg.attachments?.length) payload.attachments = msg.attachments
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.email_api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) return { ok: false, error: data }
  return { ok: true, id: data.id }
}
// ── FIM MAILER ───────────────────────────────────────────────────────────────

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
  } catch { return null }
}
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)) }

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { template_id, user_ids, filters } = await req.json()

    if (!template_id || !Array.isArray(user_ids) || !user_ids.length) {
      return new Response(JSON.stringify({ error: 'template_id e user_ids (array não vazio) são obrigatórios.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    if (user_ids.length > MAX_RECIPIENTS_PER_CALL) {
      return new Response(JSON.stringify({ error: `Máximo de ${MAX_RECIPIENTS_PER_CALL} destinatários por disparo. Divida em lotes.` }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { data: settingsRows } = await supabase.from('settings').select('key, value')
    const cfg = settingsToConfig(settingsRows)

    const { data: template } = await supabase
      .from('email_templates')
      .select('id, key, subject, body, pdf_url, pdf_filename, active')
      .eq('id', template_id)
      .maybeSingle()

    if (!template) {
      return new Response(JSON.stringify({ error: 'Modelo de e-mail não encontrado.' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    if (!template.active) {
      return new Response(JSON.stringify({ error: 'Disparo bloqueado: o modelo/campanha está inativo.' }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    let attachmentB64: string | null = null
    if (template.pdf_url) attachmentB64 = await fetchPdfAsBase64(template.pdf_url)

    const { data: users } = await supabase.from('users').select('id, name, email').in('id', user_ids)
    const { data: couponRows } = await supabase.from('coupons').select('id, users_id').in('users_id', user_ids)
    const couponIds = (couponRows || []).map((c:any)=>c.id)
    const { data: secretRows } = couponIds.length ? await supabase.rpc('get_coupon_secrets',{ p_coupon_ids: couponIds }) : { data: [] as any[] }
    const secretMap = new Map((secretRows || []).map((x:any)=>[x.coupon_id,x.link]))
    const coupons = (couponRows || []).map((c:any)=>({...c, link:secretMap.get(c.id)||''}))

    const couponsByUser: Record<string, string[]> = {}
    ;(coupons || []).forEach((c: any) => {
      if (!c.users_id) return
      ;(couponsByUser[c.users_id] ||= []).push(c.link)
    })

    let sent = 0, failed = 0
    const eventsLog: any[] = []

    for (const u of (users || [])) {
      const links = couponsByUser[u.id] || []
      const vars = { nome: firstName(u.name), nome_completo: u.name, link: links[0] || '', links: links.map((l) => `• ${l}`).join('\n') }
      const subject = renderTemplate(template.subject, vars)
      const body_ = renderTemplate(template.body, vars)
      const html = toHtml(body_)

      const attachments = attachmentB64 ? [{ filename: template.pdf_filename || 'anexo.pdf', content: attachmentB64 }] : []

      const result = await sendMail(cfg, {
        to: u.email,
        subject,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#333">${html}</div>`,
        text: body_,
        attachments,
      })

      if (result.ok) {
        sent++
        eventsLog.push({ users_id: u.id, event_type: 'campaign_email_sent', metadata: JSON.stringify({ id: result.id || null, template_key: template.key, to: u.email }) })
      } else {
        failed++
        eventsLog.push({ users_id: u.id, event_type: 'campaign_email_error', metadata: JSON.stringify({ error: result.error, template_key: template.key, to: u.email }) })
      }

      await sleep(SEND_DELAY_MS)
    }

    if (eventsLog.length) await supabase.from('events').insert(eventsLog)

    await supabase.from('email_campaign_log').insert({
      template_id: template.id, template_key: template.key, filters: filters || null,
      total_recipients: (users || []).length, total_sent: sent, total_failed: failed,
    })

    return new Response(JSON.stringify({ success: true, total: (users || []).length, sent, failed }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
