// supabase/functions/send-coupon-email/index.ts
// Deploy: supabase functions deploy send-coupon-email

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Cria cliente Supabase com service_role para acessar settings
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Busca as configurações de e-mail
    const { data: settingsRows } = await supabase
      .from('settings')
      .select('key, value')

    const cfg: Record<string, string> = {}
    ;(settingsRows || []).forEach((r: any) => { cfg[r.key] = r.value })

    const apiKey     = cfg['email_api_key']
    const from       = cfg['email_from']      || 'contato@12ia.com.br'
    const fromName   = cfg['email_from_name'] || 'Cupom GPT-Business'
    const subject    = cfg['email_subject']   || 'Seu link exclusivo chegou!'
    const template   = cfg['email_template']  || 'Olá {nome}! Seu link: {link}'

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'API Key do Resend não configurada.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Pega os dados do body
    const { user_id, coupon_id } = await req.json()

    // Busca o usuário e o cupom
    const { data: user } = await supabase
      .from('users')
      .select('name, email')
      .eq('id', user_id)
      .single()

    const { data: coupon } = await supabase
      .from('coupons')
      .select('link')
      .eq('id', coupon_id)
      .single()

    if (!user || !coupon) {
      return new Response(
        JSON.stringify({ error: 'Usuário ou cupom não encontrado.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Monta o corpo do e-mail substituindo as variáveis
    const firstName = user.name.split(' ')[0]
    const body = template
      .replace(/{nome}/g, firstName)
      .replace(/{nome_completo}/g, user.name)
      .replace(/{link}/g, coupon.link)

    // Converte quebras de linha em HTML
    const htmlBody = body
      .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>')

    // Envia via Resend
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${from}>`,
        to: [user.email],
        subject,
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#333">${htmlBody}</div>`,
        text: body,
      }),
    })

    const resendData = await resendRes.json()

    if (!resendRes.ok) {
      // Registra o erro no log de eventos
      await supabase.from('events').insert({
        users_id:   user_id,
        coupons_id: coupon_id,
        event_type: 'email_error',
        metadata:   JSON.stringify({ error: resendData }),
      })
      return new Response(
        JSON.stringify({ error: resendData }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Registra sucesso no log de eventos
    await supabase.from('events').insert({
      users_id:   user_id,
      coupons_id: coupon_id,
      event_type: 'email_sent',
      metadata:   JSON.stringify({ resend_id: resendData.id, to: user.email }),
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
