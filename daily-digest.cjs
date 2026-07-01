// AUTO daily digest → Telegram (admin đăng tay). Gửi bằng CURL. KHÔNG đụng Facebook. v2: + KỊCH BẢN REEL.
const ROOT='/opt/vp-marketing';
const { generateTodayPlan } = require(ROOT+'/dist/services/product-auto-post/orchestrator');
const { generateReelScript } = require(ROOT+'/dist/services/product-auto-post/caption-generator');
const m=require(ROOT+'/dist/db'); const getSetting=m.getSetting; const db=m.db;
const { execFileSync } = require('child_process');
(async()=>{
  const chatId=getSetting('telegram_admin_chat_id'); const token=getSetting('telegram_bot_token')||process.env.TELEGRAM_BOT_TOKEN;
  if(!chatId||!token){console.log('MISSING chat_id/token');process.exit(1);}
  const tg=(method,params)=>{const args=['-s','--max-time','30','-X','POST','https://api.telegram.org/bot'+token+'/'+method];for(const k in params)args.push('--data-urlencode',k+'='+params[k]);try{return execFileSync('curl',args,{maxBuffer:1<<21}).toString();}catch(e){return 'CURL_ERR '+(e.message||'');}};
  const sendMsg=(t)=>{const r=tg('sendMessage',{chat_id:chatId,text:t.slice(0,4090)});let ok=false;try{ok=JSON.parse(r).ok===true;}catch(e){}return ok;};
  let plan; try{plan=await generateTodayPlan();}catch(e){console.log('GEN_ERR '+(e&&e.message));process.exit(1);}
  let caption=plan&&plan.caption; let imageUrl=plan&&plan.image&&plan.image.url; let angle=plan&&plan.angle;
  const today=new Date().toISOString().slice(0,10);
  if(!caption){try{const row=db.prepare("SELECT caption_draft,image_url,angle FROM auto_post_plan WHERE scheduled_date=? ORDER BY id DESC LIMIT 1").get(today);if(row){caption=row.caption_draft;imageUrl=imageUrl||row.image_url;angle=angle||row.angle;}}catch(e){}}
  if(!caption){const reason=(plan&&plan.reason)||'unknown';sendMsg('⚠️ DIGEST '+today+': sáng nay CHƯA tạo được bài tự động.\nLý do: '+reason+'\n\n→ Thường do khách sạn thiếu ảnh hoặc hết KS đủ điều kiện. Vào sondervn.com bổ sung ảnh cho KS, hoặc thêm KS vào mạng lưới marketing.');console.log('NO_CAPTION reason='+reason+' (alert sent)');process.exit(1);}
  if(imageUrl){const isBrand=String(imageUrl).includes('og-image.jpg');tg('sendPhoto',{chat_id:chatId,photo:imageUrl,caption:isBrand?'🖼 (Ảnh BRAND tạm — KS chưa có ảnh thật, hãy chụp/đổi ảnh thật khi đăng)':'🖼 Ảnh gợi ý cho bài hôm nay'}); }
  const capText='📅 BÀI FACEBOOK HÔM NAY ('+today+(angle?' · '+angle:'')+')\n\n'+caption+'\n\n➡️ Copy nội dung + tải ảnh trên → đăng lên Facebook Page (đăng tay, bot KHÔNG tự đăng).';
  const okCap=sendMsg(capText);
  let reel=null; try{reel=await generateReelScript(caption);}catch(e){}
  let okReel=false;
  if(reel){ okReel=sendMsg('🎬 KỊCH BẢN VIDEO NGẮN (REEL) HÔM NAY\n\n'+reel+'\n\n📱 Quay bằng điện thoại 15-25s rồi đăng Reels — video reach gấp 5-10 lần bài thường.'); }
  console.log('cap='+(okCap?'OK':'FAIL')+' reel='+(reel?(okReel?'OK':'SEND_FAIL'):'NONE'));
  process.exit(okCap?0:1);
})();
