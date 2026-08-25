import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js'
import { Hono } from 'npm:hono@4.9.7'
import { z } from 'npm:zod@4.1.13'

const projectUrl = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const resourceUrl = `${projectUrl}/functions/v1/cupom-mcp`
const authServer = `${projectUrl}/auth/v1`

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'mcp-session-id',
}

function textResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], isError }
}

function bearer(request: Request) {
  const value = request.headers.get('authorization') || ''
  return value.startsWith('Bearer ') ? value.slice(7) : null
}

async function authenticatedUser(token: string) {
  const response = await fetch(`${projectUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, authorization: `Bearer ${token}` },
  })
  if (!response.ok) return null
  return await response.json()
}

async function rest(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${projectUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.message || `Supabase REST ${response.status}`)
  return { body, headers: response.headers }
}

function createServer(token: string, userId: string) {
  const server = new McpServer({ name: 'LIA Cupons', version: '1.0.0' })

  server.registerTool('consultar_quantidade_cupons', {
    title: 'Consultar quantidade de cupons',
    description: 'Consulta quantidades agregadas por status. Não altera dados.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      const statuses = ['available', 'delivered', 'redeemed', 'blocked', 'invalid', 'reserved']
      const totals: Record<string, number> = {}
      for (const status of statuses) {
        const { headers } = await rest(token, `coupons?select=id&status=eq.${status}`, {
          headers: { Prefer: 'count=exact', Range: '0-0' },
        })
        const range = headers.get('content-range') || '0/0'
        totals[status] = Number(range.split('/')[1] || 0)
      }
      totals.total = Object.values(totals).reduce((sum, value) => sum + value, 0)
      return textResult(totals)
    } catch (error) { return textResult({ erro: String(error) }, true) }
  })

  server.registerTool('listar_cupons_disponiveis', {
    title: 'Listar cupons disponíveis',
    description: 'Lista IDs e links de cupons livres. Limite máximo de 20 por chamada. Não altera dados.',
    inputSchema: { limite: z.number().int().min(1).max(20).default(10) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limite }) => {
    try {
      const { body } = await rest(token, `coupons?select=id,link,status,created_at&status=eq.available&users_id=is.null&ativado=eq.false&order=created_at.asc&limit=${limite}`)
      return textResult({ quantidade: body?.length || 0, cupons: body || [] })
    } catch (error) { return textResult({ erro: String(error) }, true) }
  })

  server.registerTool('reservar_cupom', {
    title: 'Reservar cupom',
    description: 'ALTERA DADOS. Reserva um cupom disponível. Só execute depois da confirmação explícita do usuário apresentada pelo ChatGPT.',
    inputSchema: { cupom_id: z.string().uuid(), confirmacao_usuario: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ cupom_id }) => {
    try {
      const { body } = await rest(token, `coupons?id=eq.${encodeURIComponent(cupom_id)}&status=eq.available&users_id=is.null&ativado=eq.false`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'reserved' }),
      })
      if (!body?.length) return textResult({ erro: 'Cupom não está livre para reserva.' }, true)
      await rest(token, 'events', { method: 'POST', body: JSON.stringify({ coupons_id: cupom_id, event_type: 'mcp_reserved', metadata: { actor_auth_user_id: userId, source: 'LIA MCP' } }) })
      return textResult({ sucesso: true, cupom: body[0] })
    } catch (error) { return textResult({ erro: String(error) }, true) }
  })

  server.registerTool('devolver_cupom', {
    title: 'Devolver cupom',
    description: 'ALTERA DADOS. Devolve somente um cupom reservado e não ativado. Só execute depois da confirmação explícita do usuário apresentada pelo ChatGPT.',
    inputSchema: { cupom_id: z.string().uuid(), confirmacao_usuario: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ cupom_id }) => {
    try {
      const { body } = await rest(token, `coupons?id=eq.${encodeURIComponent(cupom_id)}&status=eq.reserved&ativado=eq.false`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'available', users_id: null, distributed_at: null }),
      })
      if (!body?.length) return textResult({ erro: 'Somente cupons reservados e não ativados podem ser devolvidos.' }, true)
      await rest(token, 'events', { method: 'POST', body: JSON.stringify({ coupons_id: cupom_id, event_type: 'mcp_returned', metadata: { actor_auth_user_id: userId, source: 'LIA MCP' } }) })
      return textResult({ sucesso: true, cupom: body[0] })
    } catch (error) { return textResult({ erro: String(error) }, true) }
  })

  return server
}

const app = new Hono().basePath('/cupom-mcp')

app.options('*', c => new Response(null, { status: 204, headers: corsHeaders }))
app.get('/.well-known/oauth-protected-resource', c => c.json({
  resource: resourceUrl,
  authorization_servers: [authServer],
  scopes_supported: ['openid', 'email', 'profile'],
  resource_documentation: 'https://gpttecnologic-dot.github.io/cupons/',
}, 200, corsHeaders))

app.all('*', async c => {
  const token = bearer(c.req.raw)
  if (!token) return c.json({ error: 'unauthorized' }, 401, {
    ...corsHeaders,
    'WWW-Authenticate': `Bearer resource_metadata="${resourceUrl}/.well-known/oauth-protected-resource", scope="openid email profile"`,
  })
  const user = await authenticatedUser(token)
  if (!user?.id) return c.json({ error: 'invalid_token' }, 401, corsHeaders)

  const server = createServer(token, user.id)
  const transport = new WebStandardStreamableHTTPServerTransport()
  await server.connect(transport)
  const response = await transport.handleRequest(c.req.raw)
  const headers = new Headers(response.headers)
  Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value))
  return new Response(response.body, { status: response.status, headers })
})

Deno.serve(app.fetch)
