// send-coupon-email — deployado via Supabase Dashboard Editor
//
// Body aceito:
//   { test_email: 'alguem@exemplo.com' }               -> só testa a config de e-mail
//   { user_id, coupon_id }                              -> compatibilidade antiga (1 link)
//   { user_id, coupon_ids: [...] }                       -> vários links num único e-mail
//   { user_id, coupon_id | coupon_ids, template_key }    -> usa um modelo de email_templates
//
// Tags: {nome} {nome_completo} {link} {links}

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

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
  return { ok: false, error: 'Nenhum servidor de e-mail configurado. Preencha o SMTP na aba "Servidor SMTP" do admin.' }
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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const body = await req.json()
    const { test_email, user_id, coupon_id, coupon_ids, template_key } = body

    const { data: settingsRows } = await supabase.from('settings').select('key, value')
    const cfg = settingsToConfig(settingsRows)

    if (test_email) {
      const result = await sendMail(cfg, {
        to: test_email,
        subject: 'Teste de configuração de e-mail',
        html: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#333">✅ Se você recebeu este e-mail, a configuração de envio está funcionando.</div>',
        text: 'Se você recebeu este e-mail, a configuração de envio está funcionando.',
      })
      if (!result.ok) {
        return new Response(JSON.stringify({ error: result.error }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const ids: string[] = Array.isArray(coupon_ids) && coupon_ids.length ? coupon_ids : (coupon_id ? [coupon_id] : [])

    if (!user_id || !ids.length) {
      return new Response(JSON.stringify({ error: 'user_id e coupon_id/coupon_ids são obrigatórios.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { data: user } = await supabase.from('users').select('name, email, referral_id').eq('id', user_id).single()
    const { data: couponRows } = await supabase.from('coupons').select('id').in('id', ids)
    const { data: secretRows } = await supabase.rpc('get_coupon_secrets',{ p_coupon_ids: ids })
    const secretMap = new Map((secretRows || []).map((x:any)=>[x.coupon_id,x.link]))
    const coupons = (couponRows || []).map((c:any)=>({id:c.id, link:secretMap.get(c.id)||''}))

    if (!user || !coupons?.length) {
      return new Response(JSON.stringify({ error: 'Usuário ou cupom(ns) não encontrado(s).' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    let subjectTpl = (cfg.email_subject as string) || 'Seu link exclusivo chegou!'
    let bodyTpl    = (cfg.email_template as string) || 'Olá {nome}! Seu link: {link}'
    let pdfUrl: string | null = null
    let pdfFilename = 'anexo.pdf'
    let resolvedKey: string | null = template_key || null

    // Todo disparo depende de um modelo ativo.
    // Se o frontend nao informar template_key, usamos signup_thank_you como modelo padrao.
    const effectiveTemplateKey = template_key || 'signup_thank_you'
    let tpl: any = null

    // Primeiro resolve o modelo especifico da parceria do usuario.
    if (user.referral_id) {
      const { data } = await supabase
        .from('email_templates')
        .select('key, subject, body, pdf_url, pdf_filename, active, referral_id')
        .eq('key', effectiveTemplateKey)
        .eq('referral_id', user.referral_id)
        .maybeSingle()
      tpl = data
    }

    // Fallback seguro: somente modelo geral (sem parceria).
    if (!tpl) {
      const { data } = await supabase
        .from('email_templates')
        .select('key, subject, body, pdf_url, pdf_filename, active, referral_id')
        .eq('key', effectiveTemplateKey)
        .is('referral_id', null)
        .maybeSingle()
      tpl = data
    }

    if (!tpl) {
      return new Response(JSON.stringify({ error: 'Modelo de e-mail não encontrado.' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    if (!tpl.active) {
      return new Response(JSON.stringify({ error: 'Disparo bloqueado: o modelo de e-mail está inativo.' }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    resolvedKey = tpl.key
    if (template_key) {
      subjectTpl = tpl.subject
      bodyTpl = tpl.body
    }
    pdfUrl = tpl.pdf_url || null
    pdfFilename = tpl.pdf_filename || pdfFilename

    const links = coupons.map((c: any) => c.link).filter(Boolean)
    const linksBlock = links.map((l: string) => `• ${l}`).join('\n')
    const vars = { nome: firstName(user.name), nome_completo: user.name, link: links[0] || '', links: linksBlock }

    const subject = renderTemplate(subjectTpl, vars)
    const body_ = renderTemplate(bodyTpl, vars)
    const htmlBody = toHtml(body_)

    const attachments: MailAttachment[] = []
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
        users_id: user_id, coupons_id: couponIdForLog, event_type: 'email_error',
        metadata: JSON.stringify({ error: result.error, template_key: resolvedKey, coupon_ids: ids }),
      })
      return new Response(JSON.stringify({ error: result.error }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    await supabase.from('events').insert({
      users_id: user_id, coupons_id: couponIdForLog, event_type: 'email_sent',
      metadata: JSON.stringify({ id: result.id || null, to: user.email, template_key: resolvedKey, coupon_ids: ids }),
    })

    return new Response(JSON.stringify({ success: true, id: result.id || null }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
