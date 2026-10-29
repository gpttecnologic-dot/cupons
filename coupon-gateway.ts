
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
const EMAIL_DOMAIN_TYPO_MAP:Record<string,string>={
  'gemuio.com':'gmail.com','gmeuio.com':'gmail.com','gmeil.com':'gmail.com','gmial.com':'gmail.com','gamil.com':'gmail.com','gmai.com':'gmail.com','gmaill.com':'gmail.com','gmail.con':'gmail.com',
  'hotmial.com':'hotmail.com','hotmai.com':'hotmail.com','hotmal.com':'hotmail.com',
  'outlok.com':'outlook.com','outloo.com':'outlook.com','outlook.con':'outlook.com',
  'yahho.com':'yahoo.com','yaho.com':'yahoo.com','yahoo.con':'yahoo.com',
  'icloud.con':'icloud.com','icould.com':'icloud.com'
}
function couponEmailDomainSuggestion(email:string){
  const at=email.lastIndexOf('@')
  if(at<=0 || email.indexOf('@')!==at)return ''
  const domain=email.slice(at+1).toLowerCase()
  const suggested=EMAIL_DOMAIN_TYPO_MAP[domain]
  return suggested ? email.slice(0,at)+'@'+suggested : ''
}
function isCouponEmailValid(email:string){
  return email.length<=254 && /^[A-Z0-9._%+-]+@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}$/i.test(email)
}
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

async function releaseDirectCoupon(sb:any,requestId:string) {
  const {data:auto,error:autoError}=await sb.functions.invoke('coupon-auto-release',{body:{request_id:requestId}})
  if(autoError||!auto?.success||!auto.coupon_id)return {success:false as const}
  const {data:secrets,error:secretError}=await sb.rpc('get_coupon_secrets',{p_coupon_ids:[auto.coupon_id]})
  const secret=(secrets||[]).find((row:any)=>String(row.coupon_id)===String(auto.coupon_id))||(secrets||[])[0]
  const link=!secretError && /^https:\/\/[^\s]+$/i.test(String(secret?.link||'')) ? String(secret.link) : ''
  return {success:true as const,auto,link}
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
      if(email.endsWith('@maxxspace.com'))return out(req,{error:'Benefício indisponível para este domínio.'},403)
      const phone=normPhone(body.phone)
      const cpf=normCpf(body.cpf)
      const referralId=String(body.referral_id||'')
      const qtd=Number(body.quantidade_licencas||2)
      const device=String(body.device_id||'').slice(0,200)

      if(/[\s,]/.test(email)) return out(req,{error:'O e-mail não pode conter espaços ou vírgulas.'},400)
      const emailSuggestion=couponEmailDomainSuggestion(email)
      if(emailSuggestion) return out(req,{error:'Confira o domínio do e-mail. Você quis dizer '+emailSuggestion+'?'},400)
      if(!isCouponEmailValid(email)) return out(req,{error:'Informe um e-mail válido, como nome@gmail.com.'},400)
      if(name.length<2 || name.length>160 ||
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

      const partnerName=String(ref.name||'').trim().toLowerCase()
      const partnerNoEmailCode=['clubemutua','dynamus'].includes(partnerName)
      const [{count:emailHour},{count:directRequestEmailHour},{count:global5},{data:recentEvents}] = await Promise.all([
        sb.from('email_coupon_verifications').select('id',{count:'exact',head:true}).eq('email',email).gte('created_at',sinceHour),
        partnerNoEmailCode
          ? sb.from('coupon_release_requests').select('id',{count:'exact',head:true}).eq('email',email).eq('referral_id',referralId).gte('created_at',sinceHour)
          : Promise.resolve({count:0}),
        sb.from('events').select('id',{count:'exact',head:true}).eq('event_type','coupon_gateway_request').gte('created_at',since5),
        sb.from('events').select('metadata,created_at').eq('event_type','coupon_gateway_request').gte('created_at',sinceHour).order('created_at',{ascending:false}).limit(500)
      ])

      if((global5||0)>=40) return out(req,{error:'Muitas solicitações no momento. Tente novamente em alguns minutos.'},429)
      if((emailHour||0)+(directRequestEmailHour||0)>=3) return out(req,{error:'Limite de solicitações atingido para este e-mail. Tente novamente mais tarde.'},429)

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

      if(!partnerNoEmailCode){
        // Reutiliza um código ativo para impedir reenvios e preservar a janela de 10 minutos.
        const partnerWithCpf=['clubemutua','dynamus'].includes(partnerName)
        const {data:openCodes,error:openError}=await sb.from('email_coupon_verifications')
          .select('id,email,phone,cpf,expires_at,verified_at').eq('referral_id',referralId)
          .gt('expires_at',new Date().toISOString()).is('verified_at',null)
          .order('created_at',{ascending:true}).limit(100)
        if(openError)return out(req,{error:'Não foi possível verificar o código anterior.'},503)
        const digits=(v:string)=>String(v||'').replace(/[^0-9]/g,'')
        const previous=(openCodes||[]).find((v:any)=>
          (partnerWithCpf && cpf.length===11 && digits(v.cpf)===cpf) ||
          (!partnerWithCpf && (String(v.email||'').trim().toLowerCase()===email ||
             (digits(phone).length>=10 && digits(v.phone)===digits(phone)))))
        if(previous){
          return out(req,{success:true,status:'code_already_sent',
            ...(String(previous.email||'').trim().toLowerCase()===email ? {verification_id:previous.id} : {}),
            message:'Enviamos um código para seu e-mail. Utilize o código recebido. Ele é válido por 10 minutos.'})
        }
      }

      if(cpf.length===11){
        const {data:previous,error:previousError}=await sb.from('coupon_release_requests').select('id,status,referral_id').eq('cpf',cpf).in('status',['pending','released']).order('created_at',{ascending:true}).limit(1)
        if(previousError)return out(req,{error:'Não foi possível verificar seu cadastro.'},503)
        if(previous?.length){
          if(partnerNoEmailCode && previous[0].status==='pending' && previous[0].referral_id===referralId){
            await sb.from('events').insert({event_type:'coupon_gateway_request',metadata:{
              source:'coupon_gateway_direct_retry',ip_hash:ipHash||null,device_hash:deviceHash,email_domain:email.split('@')[1]||null,referral_id:referralId
            }})
            const retried=await releaseDirectCoupon(sb,previous[0].id)
            if(retried.success)return out(req,{success:true,status:'released',release_request_id:previous[0].id,coupon_id:retried.auto.coupon_id,user_id:retried.auto.user_id,coupon_link:retried.link})
            await sb.from('events').insert({event_type:'automatic_release_failed',metadata:{source:'coupon_gateway_direct',release_request_id:previous[0].id,referral_id:referralId,ip_hash:ipHash||null}})
            return out(req,{error:'Não foi possível concluir a liberação agora. Sua solicitação foi preservada; tente novamente em alguns minutos.',status:'auto_release_failed'},503)
          }
          return out(req,{success:true,status:'already_submitted',message:'Cadastro já enviado. Aguarde o recebimento do e-mail.'})
        }
      }
      if(partnerNoEmailCode && cpf.length===11){
        const {data:cpfUsers,error:cpfError}=await sb.from('users').select('id,cpf').not('cpf','is',null)
        if(cpfError)return out(req,{error:'Não foi possível verificar seu CPF. Tente novamente.'},503)
        const original=(cpfUsers||[]).find((u:any)=>String(u.cpf||'').replace(/[^0-9]/g,'')===cpf)
        if(original){
          const {data:duplicate,error:duplicateError}=await sb.from('coupon_release_requests').insert({
            name,email,phone,cpf,referral_id:referralId,quantidade_licencas:qtd,
            status:'rejected',user_id:original.id,decided_at:new Date().toISOString()
          }).select('id').single()
          if(duplicateError||!duplicate)return out(req,{error:'Este CPF já possui cadastro. Nenhum novo cupom foi liberado.',status:'duplicate_cpf'},409)
          await sb.from('coupon_release_notifications').upsert({
            release_request_id:duplicate.id,user_id:original.id,action_taken:'existing_coupon_found',
            message:'Nao liberado: CPF ja cadastrado anteriormente. Cadastro original preservado; nenhum novo cupom emitido.'
          },{onConflict:'release_request_id'})
          return out(req,{error:'Este CPF já possui cadastro. Nenhum novo cupom foi liberado.',status:'duplicate_cpf',release_request_id:duplicate.id},409)
        }
      }
      if(partnerNoEmailCode){
        const {data:releaseReq,error:releaseError}=await sb.from('coupon_release_requests').insert({
          name,email,phone,cpf:cpf||null,referral_id:referralId,quantidade_licencas:qtd,status:'pending'
        }).select('id').single()
        if(releaseError||!releaseReq)return out(req,{error:'Não foi possível registrar sua solicitação.'},500)
        await sb.from('events').insert({event_type:'coupon_gateway_request',metadata:{
          source:'coupon_gateway_direct',ip_hash:ipHash||null,device_hash:deviceHash,email_domain:email.split('@')[1]||null,referral_id:referralId
        }})
        const released=await releaseDirectCoupon(sb,releaseReq.id)
        if(released.success)return out(req,{success:true,status:'released',release_request_id:releaseReq.id,coupon_id:released.auto.coupon_id,user_id:released.auto.user_id,coupon_link:released.link})
        await sb.from('events').insert({event_type:'automatic_release_failed',metadata:{source:'coupon_gateway_direct',release_request_id:releaseReq.id,referral_id:referralId,ip_hash:ipHash||null}})
        return out(req,{error:'Não foi possível concluir a liberação agora. Sua solicitação foi preservada; tente novamente em alguns minutos.',status:'auto_release_failed'},503)
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
      if(String(vr.email||'').trim().toLowerCase().endsWith('@maxxspace.com'))return out(req,{error:'Benefício indisponível para este domínio.'},403)

      const {data:ref}=await sb.from('referrals').select('id,name,active').eq('id',vr.referral_id).maybeSingle()
      if(!ref?.active) return out(req,{error:'Origem indisponível.'},403)
      if(vr.verified_at){
        const {data:prior}=await sb.from('coupon_release_requests').select('id,status,coupon_id,user_id').eq('verification_id',verificationId).maybeSingle()
        if(prior?.status==='released')return out(req,{success:true,status:'released',release_request_id:prior.id,coupon_id:prior.coupon_id,user_id:prior.user_id})
        if(prior?.status==='pending'){
          const partner=String(ref.name||'').trim().toLowerCase()
          if(['clubemutua','oabma','oabrs','dynamus'].includes(partner)){
            const {data:auto,error:autoError}=await sb.functions.invoke('coupon-auto-release',{body:{request_id:prior.id}})
            if(!autoError&&auto?.success)return out(req,{success:true,status:'released',release_request_id:prior.id,coupon_id:auto.coupon_id,user_id:auto.user_id})
            return out(req,{error:'Código já confirmado; falha ao concluir envio. Não solicite outro código. Tente novamente.',status:'auto_release_failed'},503)
          }
          return out(req,{success:true,status:'pending_manual_approval',release_request_id:prior.id})
        }
        return out(req,{error:'Este código já foi utilizado. Solicite um novo código.',status:'verification_used'},409)
      }
      if(new Date(vr.expires_at).getTime()<Date.now()) return out(req,{error:'Código expirado. Solicite outro.'},410)
      if((vr.attempts||0)>=5) return out(req,{error:'Muitas tentativas. Solicite outro código.'},429)

      const received=await sha256(code)
      if(received!==vr.code_hash){
        await sb.from('email_coupon_verifications').update({attempts:(vr.attempts||0)+1}).eq('id',verificationId)
        return out(req,{error:'Código incorreto.'},400)
      }

      const cpfInRequest=String(vr.cpf||'').replace(/[^0-9]/g,'')
      if(cpfInRequest.length===11){
        const {data:previous,error:previousError}=await sb.from('coupon_release_requests').select('id').eq('cpf',cpfInRequest).in('status',['pending','released']).order('created_at',{ascending:true}).limit(1)
        if(previousError)return out(req,{error:'Não foi possível verificar seu cadastro.'},503)
        if(previous?.length)return out(req,{success:true,status:'already_submitted',message:'Cadastro já enviado. Aguarde o recebimento do e-mail.'})
      }
      // CPF ja cadastrado: conservar primeiro usuario e registrar tentativa sem liberar cupom.
      const cpfDigits=String(vr.cpf||'').replace(/[^0-9]/g,'')
      if(cpfDigits.length===11){
        const {data:cpfUsers,error:cpfErr}=await sb.from('users').select('id,name,email,cpf').not('cpf','is',null)
        if(cpfErr)return out(req,{error:'Nao foi possivel validar o CPF. Tente novamente.'},503)
        const original=(cpfUsers||[]).find((u:any)=>String(u.cpf||'').replace(/[^0-9]/g,'')===cpfDigits)
        if(original){
          const {data:duplicate,error:dupErr}=await sb.from('coupon_release_requests').insert({
            verification_id:verificationId,name:vr.name,email:vr.email,phone:vr.phone,cpf:vr.cpf,
            referral_id:vr.referral_id,quantidade_licencas:vr.quantidade_licencas,
            status:'rejected',user_id:original.id,decided_at:new Date().toISOString()
          }).select('id').single()
          if(dupErr||!duplicate)return out(req,{error:'CPF ja cadastrado. Nenhum novo cupom foi liberado.'},409)
          await sb.from('email_coupon_verifications').update({verified_at:new Date().toISOString()}).eq('id',verificationId).is('verified_at',null)
          await sb.from('coupon_release_notifications').upsert({
            release_request_id:duplicate.id,user_id:original.id,action_taken:'existing_coupon_found',
            message:'Nao liberado: CPF ja cadastrado anteriormente. Cadastro original preservado; nenhum novo cupom emitido. Verificar tentativa duplicada.'
          },{onConflict:'release_request_id'})
          return out(req,{error:'Este CPF ja possui cadastro. Nenhum novo cupom foi liberado.',status:'duplicate_cpf',release_request_id:duplicate.id},409)
        }
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

      const h=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',hour:'2-digit',hourCycle:'h23'}).format(new Date()))
      const referralName=String(ref.name||'').trim().toLowerCase()
      const isAlwaysAutoReleasePartner=['clubemutua','oabma','oabrs','dynamus'].includes(referralName)
      if(isAlwaysAutoReleasePartner){
        const {data:auto,error:autoError}=await sb.functions.invoke('coupon-auto-release',{body:{request_id:releaseReq.id}})
        if(!autoError && auto?.success) return out(req,{success:true,status:'released',release_request_id:releaseReq.id,coupon_id:auto.coupon_id,user_id:auto.user_id})
        let reason=String(auto?.error||'Não foi possível concluir a liberação automática.')
        try{if(autoError?.context?.json){const detail=await autoError.context.json();reason=String(detail?.error||reason)}}catch(_){}
        console.error('auto_release_failed',{release_request_id:releaseReq.id,reason})
        // Preservar pedido confirmado para nova tentativa segura.
        await sb.from('events').insert({event_type:'automatic_release_failed',metadata:{release_request_id:releaseReq.id,referral_id:vr.referral_id,reason}})
        return out(req,{error:'Não foi possível concluir a liberação automática: '+reason,status:'auto_release_failed'},409)
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
