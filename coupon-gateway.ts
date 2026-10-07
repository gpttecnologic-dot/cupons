
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

const ALLOWED_ORIGINS = new Set([
  'https://12ia.ia.br',
  'https://www.12ia.ia.br',
  'https://gpttecnologic-dot.github.io'
])

function cors(req: Request) {
  const origin = req.headers.get('origin') || ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://12ia.ia.br',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}
function out(req:Request,data:unknown,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{...cors(req),'content-type':'application/json','cache-control':'no-store'}
  })
}
function normEmail(v:string){return String(v||'').trim().toLowerCase()}
function normPhone(v:string){return String(v||'').replace(/\D/g,'')}
function normCpf(v:string){return String(v||'').replace(/\D/g,'')}
function uuidish(v:string){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)}
function badUa(v:string){return !v || /(formtestqa|python-urllib|python-requests|curl|wget|httpx|aiohttp|go-http-client|postmanruntime|insomnia|scrapy|selenium|playwright|puppeteer)/i.test(v)}
function clientIp(req:Request){
  return (req.headers.get('cf-connecting-ip') || (req.headers.get('x-forwarded-for')||'').split(',')[0] || '').trim()
}
async function sha256(v:string){
  const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')
}
function secureCode(){
  const a=new Uint32Array(1); crypto.getRandomValues(a)
  return String(100000 + (a[0] % 900000))
}
function config(rows:any[]|null){
  const c:any={}; for(const r of rows||[]) c[r.key]=r.value; return c
}
async function sendMail(cfg:any,to:string,subject:string,text:string){
  const html='<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#333">'+text.replace(/\n/g,'<br>')+'</div>'
  const from=cfg.email_from||'contato@12ia.com.br'
  const fromName=cfg.email_from_name||'Cupom GPT-Business'
  if(cfg.smtp_host){
    const client=new SMTPClient({connection:{
      hostname:cfg.smtp_host,
      port:parseInt(cfg.smtp_port||'587',10),
      tls:(cfg.smtp_secure||'starttls').toLowerCase()==='ssl',
      auth:cfg.smtp_user?{username:cfg.smtp_user,password:cfg.smtp_password||''}:undefined,
    }})
    try{
      await client.send({from:fromName+' <'+from+'>',to,subject,html,content:text})
      await client.close(); return {ok:true}
    }catch(e){
      try{await client.close()}catch{}
      return {ok:false,error:String(e)}
    }
  }
  if(cfg.email_api_key){
    const res=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{authorization:'Bearer '+cfg.email_api_key,'content-type':'application/json'},
      body:JSON.stringify({from:fromName+' <'+from+'>',to:[to],subject,html,text})
    })
    const data=await res.json().catch(()=>({}))
    return res.ok?{ok:true,id:data.id}:{ok:false,error:data}
  }
  return {ok:false,error:'Nenhum servidor de e-mail configurado.'}
}

Deno.serve(async req=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors(req)})
  if(req.method!=='POST') return out(req,{error:'Método não permitido.'},405)

  const origin=req.headers.get('origin')||''
  if(origin && !ALLOWED_ORIGINS.has(origin)) return out(req,{error:'Origem não permitida.'},403)

  try{
    const body=await req.json().catch(()=>({}))
    const action=String(body.action||'')
    const url=Deno.env.get('SUPABASE_URL')||''
    const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||''
    const sb=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}})
    const ua=(req.headers.get('user-agent')||'').slice(0,500)
    const ip=clientIp(req)
    const ipHash=ip?await sha256(ip):''

    if(action==='referral_config'){
      const slug=String(body.slug||'').trim().toLowerCase()
      if(!slug || slug.length>100) return out(req,{error:'Indicação inválida.'},400)
      const {data:ref}=await sb.from('referrals')
        .select('id,name,active,protected_origin,allowed_origin,allowed_origins,logo_url')
        .ilike('name',slug).eq('active',true).maybeSingle()
      if(!ref) return out(req,{error:'Indicação indisponível.'},404)
      return out(req,{success:true,referral:ref})
    }

    if(badUa(ua)) return out(req,{error:'Solicitação bloqueada.'},403)

    if(action==='request'){
      const name=String(body.name||'').trim().slice(0,160)
      const email=normEmail(body.email)
      const phone=normPhone(body.phone)
      const cpf=normCpf(body.cpf)
      const referralId=String(body.referral_id||'')
      const qtd=Number(body.quantidade_licencas||2)
      const device=String(body.device_id||'').slice(0,200)

      if(name.length<2 || name.length>160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
         phone.length<10 || phone.length>13 || !uuidish(referralId) ||
         !Number.isInteger(qtd) || qtd<1 || qtd>10 || !uuidish(device)){
        return out(req,{error:'Dados inválidos.'},400)
      }

      const {data:ref}=await sb.from('referrals')
        .select('id,name,active,protected_origin').eq('id',referralId).maybeSingle()
      if(!ref?.active) return out(req,{error:'Origem indisponível.'},403)
      if(ref.protected_origin && cpf.length!==11) return out(req,{error:'CPF obrigatório.'},400)

      const deviceHash=await sha256(device)
      const sinceHour=new Date(Date.now()-60*60*1000).toISOString()
      const since5=new Date(Date.now()-5*60*1000).toISOString()

      const [{count:emailHour},{count:global5},{data:recentEvents}] = await Promise.all([
        sb.from('email_coupon_verifications').select('id',{count:'exact',head:true}).eq('email',email).gte('created_at',sinceHour),
        sb.from('events').select('id',{count:'exact',head:true}).eq('event_type','coupon_gateway_request').gte('created_at',since5),
        sb.from('events').select('metadata,created_at').eq('event_type','coupon_gateway_request').gte('created_at',sinceHour).order('created_at',{ascending:false}).limit(500)
      ])

      if((global5||0)>=40) return out(req,{error:'Muitas solicitações no momento. Tente novamente em alguns minutos.'},429)
      if((emailHour||0)>=3) return out(req,{error:'Limite de solicitações atingido para este e-mail. Tente novamente mais tarde.'},429)

      let ipCount=0, deviceCount=0
      for(const row of recentEvents||[]){
        const m:any=row.metadata||{}
        if(ipHash && m.ip_hash===ipHash) ipCount++
        if(m.device_hash===deviceHash) deviceCount++
      }
      if((ipHash && ipCount>=6) || deviceCount>=4){
        await sb.from('events').insert({event_type:'security_block',metadata:{
          source:'coupon_gateway_v8',reason:'rate_limit',ip_hash:ipHash||null,device_hash:deviceHash,email_domain:email.split('@')[1]||null,user_agent:ua
        }})
        return out(req,{error:'Muitas solicitações. Tente novamente mais tarde.'},429)
      }

      const {data:recent}=await sb.from('email_coupon_verifications')
        .select('created_at').eq('email',email).order('created_at',{ascending:false}).limit(1)
      if(recent?.length && Date.now()-new Date(recent[0].created_at).getTime()<60000){
        return out(req,{error:'Aguarde 1 minuto antes de solicitar um novo código.'},429)
      }

      const code=secureCode()
      const codeHash=await sha256(code)
      const expiresAt=new Date(Date.now()+10*60*1000).toISOString()

      const {data:row,error:insErr}=await sb.from('email_coupon_verifications').insert({
        email,name,phone,cpf:cpf||null,referral_id:referralId,quantidade_licencas:qtd,code_hash:codeHash,expires_at:expiresAt
      }).select('id').single()
      if(insErr||!row) return out(req,{error:'Não foi possível iniciar a validação.'},500)

      const {data:settingsRows}=await sb.from('settings').select('key,value')
      const mail=await sendMail(config(settingsRows),email,'Confirme seu e-mail para receber o cupom',
        'Olá '+name.split(/\s+/)[0]+'!\n\nSeu código de confirmação é: '+code+'\n\nEle expira em 10 minutos.\n\nApós a confirmação, sua solicitação ficará aguardando liberação pela equipe.')

      if(!mail.ok){
        await sb.from('email_coupon_verifications').delete().eq('id',row.id)
        await sb.from('events').insert({event_type:'email_error',metadata:{source:'coupon_gateway_v8',stage:'verification_code',email_domain:email.split('@')[1]||null}})
        return out(req,{error:'Não foi possível enviar o código de confirmação.'},500)
      }

      await sb.from('events').insert({event_type:'coupon_gateway_request',metadata:{
        source:'coupon_gateway_v8',ip_hash:ipHash||null,device_hash:deviceHash,email_domain:email.split('@')[1]||null,referral_id:referralId
      }})

      return out(req,{success:true,verification_id:row.id})
    }

    if(action==='verify'){
      const verificationId=String(body.verification_id||'')
      const code=String(body.code||'').replace(/\D/g,'').slice(0,6)
      if(!uuidish(verificationId)||!/^[0-9]{6}$/.test(code)) return out(req,{error:'Código inválido.'},400)

      const {data:vr}=await sb.from('email_coupon_verifications').select('*').eq('id',verificationId).maybeSingle()
      if(!vr) return out(req,{error:'Validação não encontrada.'},404)

      const {data:ref}=await sb.from('referrals').select('id,active').eq('id',vr.referral_id).maybeSingle()
      if(!ref?.active) return out(req,{error:'Origem indisponível.'},403)
      if(vr.verified_at) return out(req,{error:'Este código já foi utilizado.'},409)
      if(new Date(vr.expires_at).getTime()<Date.now()) return out(req,{error:'Código expirado. Solicite outro.'},410)
      if((vr.attempts||0)>=5) return out(req,{error:'Muitas tentativas. Solicite outro código.'},429)

      const received=await sha256(code)
      if(received!==vr.code_hash){
        await sb.from('email_coupon_verifications').update({attempts:(vr.attempts||0)+1}).eq('id',verificationId)
        return out(req,{error:'Código incorreto.'},400)
      }

      const {data:releaseReq,error:releaseErr}=await sb.from('coupon_release_requests').insert({
        verification_id:verificationId,name:vr.name,email:vr.email,phone:vr.phone,cpf:vr.cpf||null,
        referral_id:vr.referral_id,quantidade_licencas:vr.quantidade_licencas,status:'pending'
      }).select('id').single()

      if(releaseErr||!releaseReq){
        const {data:existing}=await sb.from('coupon_release_requests').select('id,status').eq('verification_id',verificationId).maybeSingle()
        if(existing) return out(req,{success:true,status:existing.status==='pending'?'pending_manual_approval':existing.status,release_request_id:existing.id})
        return out(req,{error:'Não foi possível registrar a solicitação para liberação manual.'},500)
      }

      const {data:verified,error:verifiedErr}=await sb.from('email_coupon_verifications')
        .update({verified_at:new Date().toISOString()}).eq('id',verificationId).is('verified_at',null).select('id').maybeSingle()

      if(verifiedErr||!verified){
        await sb.from('coupon_release_requests').delete().eq('id',releaseReq.id)
        return out(req,{error:'Não foi possível concluir a confirmação do e-mail.'},500)
      }

      await sb.from('events').insert({event_type:'manual_release_pending',metadata:{
        source:'coupon_gateway_v8',release_request_id:releaseReq.id,email_verified:true,referral_id:vr.referral_id,ip_hash:ipHash||null
      }})

      return out(req,{success:true,status:'pending_manual_approval',release_request_id:releaseReq.id})
    }

    return out(req,{error:'Ação inválida.'},400)
  }catch(e){
    console.error('coupon-gateway v8',e)
    return out(req,{error:'Falha temporária no serviço.'},500)
  }
})
