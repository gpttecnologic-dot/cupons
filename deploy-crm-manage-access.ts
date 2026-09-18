// crm-manage-access — deployado via Supabase Dashboard Editor
//
// Só quem já está em crm_admins pode chamar isso (o resto é bloqueado com
// 403). Serve pra: listar quem tem acesso a quais empresas, liberar acesso
// de um e-mail a uma empresa (criando o login se ainda não existir), tirar
// acesso, e marcar/desmarcar alguém como admin.
//
// Precisa disso porque a tabela auth.users e a criação de login exigem a
// service_role key — não dá pra fazer isso direto do admin.html com a chave
// anon (nem seria seguro deixar qualquer usuário logado criar outros logins).
//
// Body: { action: 'list_members' }
//     | { action: 'grant', email, company_id, password? }
//     | { action: 'revoke', user_id, company_id }
//     | { action: 'set_admin', user_id, is_admin }

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

function randomPassword() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 14)
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

    const { data: adminRow } = await admin.from('crm_admins').select('user_id').eq('user_id', caller.id).maybeSingle()
    if (!adminRow) return bad('Só administradores do CRM podem gerenciar acesso.', 403)

    const body = await req.json()
    const action = body.action

    if (action === 'list_members') {
      const { data: uca } = await admin
        .from('user_company_access')
        .select('user_id, company_id, companies(id, name)')
      const { data: adminsRows } = await admin.from('crm_admins').select('user_id')
      const adminIds = new Set((adminsRows || []).map((r: { user_id: string }) => r.user_id))
      const ids = [...new Set([...(uca || []).map((r: { user_id: string }) => r.user_id), ...adminIds])]

      const members = []
      for (const id of ids) {
        const { data } = await admin.auth.admin.getUserById(id)
        members.push({
          user_id: id,
          email: data?.user?.email || '(desconhecido)',
          is_admin: adminIds.has(id),
          companies: (uca || [])
            .filter((r: { user_id: string }) => r.user_id === id)
            // deno-lint-ignore no-explicit-any
            .map((r: any) => ({ id: r.company_id, name: r.companies?.name || '?' })),
        })
      }
      members.sort((a, b) => a.email.localeCompare(b.email))
      return ok({ members })
    }

    if (action === 'grant') {
      const { email, company_id } = body
      if (!email || !company_id) return bad('email e company_id são obrigatórios.')

      let targetUser = await findUserByEmail(admin, email)
      let createdNew = false
      let tempPassword: string | null = null

      if (!targetUser) {
        tempPassword = body.password || randomPassword()
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password: tempPassword,
          email_confirm: true,
        })
        if (error) return bad('Erro ao criar login: ' + error.message)
        targetUser = data.user
        createdNew = true
      }

      const { error: insErr } = await admin
        .from('user_company_access')
        .upsert({ user_id: targetUser!.id, company_id }, { onConflict: 'user_id,company_id' })
      if (insErr) return bad(insErr.message)

      return ok({ success: true, user_id: targetUser!.id, created_new: createdNew, temp_password: tempPassword })
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
