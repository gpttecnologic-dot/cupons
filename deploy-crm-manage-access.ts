// crm-manage-access — deployado via Supabase Dashboard Editor
//
// Camadas de permissão:
//   - system_admins: "administrador" geral, enxerga TODAS as abas do
//     admin.html (não só o CRM). Só quem já É admin geral pode mexer nisso
//     (ação set_system_admin, ou set_permissions com is_system_admin).
//   - crm_admins: "admin do CRM" / sub-administrador, enxerga e mexe em
//     TODAS as empresas dentro do CRM, mas só tem acesso à aba CRM (a não
//     ser que também seja admin geral). Quem já é crm_admin pode chamar as
//     ações de empresa daqui (list_members, grant, revoke, set_admin).
//   - user_company_access: acesso avulso a UMA empresa específica do CRM.
//   - user_tab_access: acesso avulso a UMA aba específica do sistema fora do
//     CRM (ex: só "Indicações"). Só admin geral mexe nisso (set_permissions).
//   - user_referral_access: acesso ao painel "Meu Desempenho" de UMA
//     indicação específica (parceiro/afiliado). Só admin geral mexe nisso
//     (set_permissions).
//
// Precisa disso porque a tabela auth.users e a criação de login exigem a
// service_role key — não dá pra fazer isso direto do admin.html com a chave
// anon (nem seria seguro deixar qualquer usuário logado criar outros logins).
//
// Login novo = convite por e-mail: a pessoa recebe um link, clica, e cria a
// PRÓPRIA senha no admin.html (não tem mais senha temporária gerada aqui).
//   IMPORTANTE: o e-mail do convite NÃO usa o mailer interno do Supabase Auth
//   (admin.auth.admin.inviteUserByEmail manda pelo serviço de e-mail do
//   próprio Supabase, que aqui nunca foi configurado — por isso os convites
//   não chegavam). Em vez disso, geramos o link com
//   admin.auth.admin.generateLink({type:'invite'}) — que cria o login mas NÃO
//   manda e-mail nenhum — e enviamos o link nós mesmos pelo mesmo SMTP já
//   configurado na aba "Servidor SMTP" (tabela `settings`), igual ao que
//   send-coupon-email/send-campaign-email já usam com sucesso. Se o envio
//   falhar mesmo assim, a resposta devolve o link em `invite_link` pra
//   copiar/colar manualmente — o login já foi criado de qualquer forma.
//
// Body: { action: 'list_members' }
//     | { action: 'grant', email, company_id?, origin? }  — company_id é
//       opcional: cria/convida o login (se ainda não existir) e, se vier
//       company_id, libera acesso a essa empresa. origin é a origem do
//       admin.html (window.location.origin) pra montar o link do convite.
//     | { action: 'revoke', user_id, company_id }
//     | { action: 'set_admin', user_id, is_admin }
//     | { action: 'set_system_admin', user_id, is_system_admin }
//     | { action: 'set_permissions', user_id, company_ids?, tab_ids?,
//         referral_ids?, is_admin?, is_system_admin? }  — edição completa,
//       só admin geral. Cada lista (quando enviada) substitui o conjunto
//       atual inteiro (reconciliação: apaga o que saiu, adiciona o que é
//       novo). Omitir uma lista deixa aquele conjunto como está.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ── MAILER (SMTP com fallback pra Resend) — mesmo código de send-coupon-email,
// duplicado aqui porque o editor do Supabase Dashboard publica um arquivo por
// vez (sem pasta _shared). Lê a config da tabela `settings` (aba "Servidor
// SMTP" do admin.html) — é o mesmo servidor que já entrega e-mail de cupom. ──
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
interface MailMessage { to: string; subject: string; html: string; text: string }
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
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.email_api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) return { ok: false, error: data }
  return { ok: true, id: data.id }
}
// ── FIM MAILER ────────────────────────────────────────────────────────────

function inviteEmailHtml(link: string, fromName: string) {
  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#333">
    <p>Você foi convidado(a) a acessar o painel de gestão${fromName ? ' da ' + fromName : ''}.</p>
    <p>Clique no botão abaixo pra criar sua senha e entrar:</p>
    <p style="margin:24px 0"><a href="${link}" style="background:#6c5ce7;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Criar minha senha</a></p>
    <p style="font-size:12px;color:#888">Se o botão não funcionar, copie e cole este link no navegador:<br>${link}</p>
  </div>`
}
function inviteEmailText(link: string, fromName: string) {
  return `Você foi convidado(a) a acessar o painel de gestão${fromName ? ' da ' + fromName : ''}.\n\nCrie sua senha nesse link:\n${link}`
}

function ok(obj: unknown) {
  return new Response(JSON.stringify(obj), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
function bad(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Acha um usuário existente pelo e-mail. O supabase-js v2 não tem
// getUserByEmail no admin API, então pagina por listUsers e filtra.
// deno-lint-ignore no-explicit-any
async function findUserByEmail(admin: any, email: string) {
  const target = email.trim().toLowerCase()
  let page = 1
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) return null
    const users = data?.users || []
    const found = users.find((u: { email?: string }) => (u.email || '').toLowerCase() === target)
    if (found) return found
    if (users.length < 200) return null
    page++
  }
}

// Mantém crm_profiles em dia (espelho leve de user_id+email pra montar
// seletores de "responsável" no client sem precisar de service role).
// deno-lint-ignore no-explicit-any
async function syncProfile(admin: any, userId: string, email: string) {
  await admin.from('crm_profiles').upsert({ user_id: userId, email }, { onConflict: 'user_id' })
}

// Reconcilia uma tabela de permissão com chave composta (user_id + col) pro
// conjunto desejado: apaga as linhas que saíram, insere as que são novas.
// deno-lint-ignore no-explicit-any
async function reconcileSet(admin: any, table: string, col: string, userId: string, desired: string[]) {
  const list = Array.isArray(desired) ? [...new Set(desired.filter(Boolean))] : []
  const { data: current } = await admin.from(table).select(col).eq('user_id', userId)
  // deno-lint-ignore no-explicit-any
  const currentIds = new Set((current || []).map((r: any) => r[col]))
  const desiredSet = new Set(list)
  const toRemove = [...currentIds].filter((id) => !desiredSet.has(id))
  const toAdd = list.filter((id) => !currentIds.has(id))
  if (toRemove.length) {
    const { error } = await admin.from(table).delete().eq('user_id', userId).in(col, toRemove)
    if (error) return error.message
  }
  if (toAdd.length) {
    const { error } = await admin.from(table).insert(toAdd.map((id) => ({ user_id: userId, [col]: id })))
    if (error) return error.message
  }
  return null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '')
    if (!jwt) return bad('Não autenticado.', 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const admin = createClient(supabaseUrl, serviceKey)

    const { data: { user: caller }, error: callerErr } = await admin.auth.getUser(jwt)
    if (callerErr || !caller) return bad('Não autenticado.', 401)

    const { data: sysAdminRow } = await admin.from('system_admins').select('user_id').eq('user_id', caller.id).maybeSingle()
    const callerIsSystemAdmin = !!sysAdminRow

    const { data: adminRow } = await admin.from('crm_admins').select('user_id').eq('user_id', caller.id).maybeSingle()
    const callerIsCrmAdmin = !!adminRow || callerIsSystemAdmin

    const body = await req.json()
    const action = body.action

    // set_system_admin e set_permissions exigem admin geral — as outras ações
    // abaixo exigem (pelo menos) admin do CRM.
    if (action === 'set_system_admin') {
      if (!callerIsSystemAdmin) return bad('Só administradores gerais podem gerenciar administradores gerais.', 403)
      const { user_id, is_system_admin } = body
      if (!user_id) return bad('user_id é obrigatório.')
      if (is_system_admin) {
        const { error } = await admin.from('system_admins').upsert({ user_id })
        if (error) return bad(error.message)
      } else {
        if (user_id === caller.id) return bad('Você não pode remover seu próprio acesso de administrador geral por aqui.')
        const { error } = await admin.from('system_admins').delete().eq('user_id', user_id)
        if (error) return bad(error.message)
      }
      return ok({ success: true })
    }

    if (action === 'set_permissions') {
      if (!callerIsSystemAdmin) return bad('Só administradores gerais podem editar permissões completas.', 403)
      const { user_id, company_ids, tab_ids, referral_ids, is_admin, is_system_admin } = body
      if (!user_id) return bad('user_id é obrigatório.')

      if (typeof is_admin === 'boolean') {
        if (is_admin) {
          const { error } = await admin.from('crm_admins').upsert({ user_id })
          if (error) return bad(error.message)
        } else if (user_id !== caller.id) {
          const { error } = await admin.from('crm_admins').delete().eq('user_id', user_id)
          if (error) return bad(error.message)
        }
      }
      if (typeof is_system_admin === 'boolean') {
        if (is_system_admin) {
          const { error } = await admin.from('system_admins').upsert({ user_id })
          if (error) return bad(error.message)
        } else if (user_id !== caller.id) {
          const { error } = await admin.from('system_admins').delete().eq('user_id', user_id)
          if (error) return bad(error.message)
        }
      }

      if (Array.isArray(company_ids)) {
        const err = await reconcileSet(admin, 'user_company_access', 'company_id', user_id, company_ids)
        if (err) return bad(err)
      }
      if (Array.isArray(tab_ids)) {
        const err = await reconcileSet(admin, 'user_tab_access', 'tab_id', user_id, tab_ids)
        if (err) return bad(err)
      }
      if (Array.isArray(referral_ids)) {
        const err = await reconcileSet(admin, 'user_referral_access', 'referral_id', user_id, referral_ids)
        if (err) return bad(err)
      }

      const { data: u } = await admin.auth.admin.getUserById(user_id)
      if (u?.user?.email) await syncProfile(admin, user_id, u.user.email)

      return ok({ success: true })
    }

    if (!callerIsCrmAdmin) return bad('Só administradores do CRM podem gerenciar acesso.', 403)

    if (action === 'list_members') {
      const { data: uca } = await admin
        .from('user_company_access')
        .select('user_id, company_id, companies(id, name)')
      const { data: adminsRows } = await admin.from('crm_admins').select('user_id')
      const { data: sysAdminsRows } = await admin.from('system_admins').select('user_id')
      const { data: utaRows } = await admin.from('user_tab_access').select('user_id, tab_id')
      const { data: uraRows } = await admin.from('user_referral_access').select('user_id, referral_id, referrals(id, name)')

      const adminIds = new Set((adminsRows || []).map((r: { user_id: string }) => r.user_id))
      const sysAdminIds = new Set((sysAdminsRows || []).map((r: { user_id: string }) => r.user_id))
      const ids = [...new Set([
        ...(uca || []).map((r: { user_id: string }) => r.user_id),
        ...adminIds,
        ...sysAdminIds,
        ...(utaRows || []).map((r: { user_id: string }) => r.user_id),
        ...(uraRows || []).map((r: { user_id: string }) => r.user_id),
      ])]

      const members = []
      for (const id of ids) {
        const { data } = await admin.auth.admin.getUserById(id)
        members.push({
          user_id: id,
          email: data?.user?.email || '(desconhecido)',
          is_admin: adminIds.has(id),
          is_system_admin: sysAdminIds.has(id),
          companies: (uca || [])
            .filter((r: { user_id: string }) => r.user_id === id)
            // deno-lint-ignore no-explicit-any
            .map((r: any) => ({ id: r.company_id, name: r.companies?.name || '?' })),
          tab_ids: (utaRows || [])
            .filter((r: { user_id: string }) => r.user_id === id)
            .map((r: { tab_id: string }) => r.tab_id),
          referrals: (uraRows || [])
            .filter((r: { user_id: string }) => r.user_id === id)
            // deno-lint-ignore no-explicit-any
            .map((r: any) => ({ id: r.referral_id, name: r.referrals?.name || '?' })),
        })
      }
      members.sort((a, b) => a.email.localeCompare(b.email))
      return ok({ members, caller_is_system_admin: callerIsSystemAdmin })
    }

    if (action === 'grant') {
      const { email, company_id, origin } = body
      if (!email) return bad('email é obrigatório.')

      let targetUser = await findUserByEmail(admin, email)
      let createdNew = false
      let invited = false
      let mailError: string | null = null
      let inviteLink: string | null = null

      if (!targetUser) {
        const redirectTo = (origin || 'https://12ia.ia.br').replace(/\/$/, '') + '/admin.html'
        const { data, error } = await admin.auth.admin.generateLink({
          type: 'invite',
          email,
          options: { redirectTo },
        })
        if (error) return bad('Erro ao criar login: ' + error.message)
        targetUser = data.user
        createdNew = true
        inviteLink = data.properties?.action_link || null

        if (inviteLink) {
          const { data: settingsRows } = await admin.from('settings').select('key, value')
          const cfg = settingsToConfig(settingsRows)
          const fromName = cfg.email_from_name || ''
          const result = await sendMail(cfg, {
            to: email,
            subject: 'Seu acesso ao painel — crie sua senha',
            html: inviteEmailHtml(inviteLink, fromName),
            text: inviteEmailText(inviteLink, fromName),
          })
          if (result.ok) {
            invited = true
          } else {
            mailError = typeof result.error === 'string' ? result.error : JSON.stringify(result.error)
          }
        } else {
          mailError = 'Não foi possível gerar o link de convite.'
        }
      }

      // company_id é opcional: um admin geral ou admin do CRM já enxerga tudo
      // sem precisar de uma linha por empresa (ver crm_has_company_access no
      // banco). Só grava o vínculo quando uma empresa específica foi escolhida.
      if (company_id) {
        const { error: insErr } = await admin
          .from('user_company_access')
          .upsert({ user_id: targetUser!.id, company_id }, { onConflict: 'user_id,company_id' })
        if (insErr) return bad(insErr.message)
      }

      await syncProfile(admin, targetUser!.id, targetUser!.email || email)

      return ok({
        success: true,
        user_id: targetUser!.id,
        created_new: createdNew,
        invited,
        // Só preenchidos quando o login é novo mas o e-mail não saiu — dá pra
        // copiar o link e mandar manualmente. O login já foi criado de
        // qualquer forma, então isso nunca bloqueia o cadastro em si.
        mail_error: mailError,
        invite_link: mailError ? inviteLink : null,
      })
    }

    if (action === 'revoke') {
      const { user_id, company_id } = body
      if (!user_id || !company_id) return bad('user_id e company_id são obrigatórios.')
      const { error } = await admin.from('user_company_access').delete().eq('user_id', user_id).eq('company_id', company_id)
      if (error) return bad(error.message)
      return ok({ success: true })
    }

    if (action === 'set_admin') {
      const { user_id, is_admin } = body
      if (!user_id) return bad('user_id é obrigatório.')
      if (is_admin) {
        const { error } = await admin.from('crm_admins').upsert({ user_id })
        if (error) return bad(error.message)
        const { data: u } = await admin.auth.admin.getUserById(user_id)
        if (u?.user?.email) await syncProfile(admin, user_id, u.user.email)
      } else {
        if (user_id === caller.id) return bad('Você não pode remover seu próprio acesso de admin por aqui.')
        const { error } = await admin.from('crm_admins').delete().eq('user_id', user_id)
        if (error) return bad(error.message)
      }
      return ok({ success: true })
    }

    return bad('Ação desconhecida.')
  } catch (err) {
    return bad(String(err), 500)
  }
})
