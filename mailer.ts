// supabase/functions/_shared/mailer.ts
//
// Módulo compartilhado de envio de e-mail, usado por send-coupon-email e
// send-campaign-email. Fica em _shared porque as duas functions precisam do
// mesmo código de envio — Supabase Edge Functions permite importar arquivos
// de fora da pasta da function via caminho relativo (ex: '../_shared/mailer.ts').
//
// Lê a configuração da tabela `settings` (chave/valor) e decide como enviar:
//   1) Se smtp_host estiver preenchido -> manda via SMTP de verdade
//      (host/porta/usuário/senha/criptografia), usando a lib "denomailer".
//   2) Senão, se email_api_key estiver preenchido -> manda via Resend (modo
//      antigo, mantido só como fallback pra quem ainda não migrou pro SMTP).
//   3) Senão -> erro "nenhum servidor de e-mail configurado".
//
// Chaves esperadas em `settings`:
//   smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure
//     (smtp_secure: 'ssl' = TLS implícito/porta 465 · 'starttls' = porta 587
//      · 'none' = sem criptografia/porta 25, não recomendado)
//   email_from, email_from_name  -> remetente (usado nos dois modos)
//   email_api_key                -> chave do Resend (só no modo fallback)

import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

export interface MailSettings {
  smtp_host?: string
  smtp_port?: string
  smtp_user?: string
  smtp_password?: string
  smtp_secure?: string
  email_api_key?: string
  email_from?: string
  email_from_name?: string
}

export interface MailAttachment {
  filename: string
  content: string // base64
}

export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  attachments?: MailAttachment[]
}

export interface MailResult {
  ok: boolean
  id?: string
  error?: unknown
}

export function settingsToConfig(rows: { key: string; value: string }[] | null): MailSettings {
  const cfg: Record<string, string> = {}
  ;(rows || []).forEach((r) => { cfg[r.key] = r.value })
  return cfg as MailSettings
}

export async function sendMail(cfg: MailSettings, msg: MailMessage): Promise<MailResult> {
  if (cfg.smtp_host) return sendViaSmtp(cfg, msg)
  if (cfg.email_api_key) return sendViaResend(cfg, msg)
  return { ok: false, error: 'Nenhum servidor de e-mail configurado. Preencha o SMTP na aba "Servidor SMTP" do admin.' }
}

// A lib denomailer, em alguns erros do protocolo SMTP (ex: usuário/senha
// rejeitados pelo Gmail, "invalid cmd" na negociação), lança a exceção fora
// da cadeia de promises que o nosso `await client.send()` consegue capturar
// — ela aparece como "unhandledrejection" / "event loop error" no runtime do
// Deno e, sem tratamento, DERRUBA a Edge Function inteira (o isolate reinicia
// no meio da resposta). O efeito colateral visto no navegador é um erro
// genérico de CORS/"Failed to fetch", escondendo o erro real. Por isso
// registramos um listener de 'unhandledrejection' só durante o envio, pra
// converter qualquer erro assíncrono desse tipo numa resposta normal.
async function sendViaSmtp(cfg: MailSettings, msg: MailMessage): Promise<MailResult> {
  const from = cfg.email_from || 'contato@12ia.com.br'
  const fromName = cfg.email_from_name || 'Cupom GPT-Business'
  const port = parseInt(cfg.smtp_port || '587', 10)
  const secure = (cfg.smtp_secure || 'starttls').toLowerCase()

  const client = new SMTPClient({
    connection: {
      hostname: cfg.smtp_host as string,
      port,
      tls: secure === 'ssl', // true = TLS implícito (porta 465). STARTTLS (587) é negociado automaticamente pela lib quando o servidor oferece.
      auth: cfg.smtp_user
        ? { username: cfg.smtp_user, password: cfg.smtp_password || '' }
        : undefined,
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
          attachments: (msg.attachments || []).map((a) => ({
            filename: a.filename,
            content: a.content,
            encoding: 'base64' as const,
          })),
        })
        await client.close()
        finish({ ok: true })
      } catch (err) {
        try { await client.close() } catch { /* já pode ter caído a conexão */ }
        finish({ ok: false, error: String(err) })
      }
    })()
  })
}

async function sendViaResend(cfg: MailSettings, msg: MailMessage): Promise<MailResult> {
  const from = cfg.email_from || 'contato@12ia.com.br'
  const fromName = cfg.email_from_name || 'Cupom GPT-Business'

  const payload: Record<string, unknown> = {
    from: `${fromName} <${from}>`,
    to: [msg.to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  }
  if (msg.attachments?.length) payload.attachments = msg.attachments

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.email_api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) return { ok: false, error: data }
  return { ok: true, id: data.id }
}
