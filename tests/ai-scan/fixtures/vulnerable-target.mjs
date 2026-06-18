import http from 'http';
import { execSync } from 'child_process';

const uploads = new Map();
function send(res, status, body, headers={}) { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(body); }
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }
function parseMultipart(req, contentType, cb) {
  const chunks=[]; req.on('data', c=>chunks.push(c)); req.on('end',()=>{
    const buf=Buffer.concat(chunks); const boundary=(contentType.match(/boundary=(.+)$/)||[])[1];
    if(!boundary) return cb(null, []);
    const parts=buf.toString('binary').split('--'+boundary).filter(p=>p.includes('Content-Disposition'));
    cb(null, parts.map(p=>{
      const name=(p.match(/name="([^"]+)"/)||[])[1]||'file';
      const filename=(p.match(/filename="([^"]*)"/)||[])[1]||'upload.bin';
      const ct=(p.match(/Content-Type:\s*([^\r\n]+)/i)||[])[1]||'application/octet-stream';
      const body=p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/,'');
      return {name, filename, contentType:ct, body:Buffer.from(body,'binary')};
    }));
  });
}

const port = Number(process.env.PORT || 3200);
const server=http.createServer((req,res)=>{
  const url=new URL(req.url, `http://localhost:${port}`);
  if(req.method==='GET' && url.pathname==='/') return send(res,200,`<!doctype html><title>Vulnerable Shop Community Admin</title>
    <h1>Vulnerable Shop</h1>
    <a href="/profile">Profile avatar upload</a>
    <a href="/community">Community</a>
    <a href="/orders">Orders</a>
    <a href="/download?file=public.txt">Download public file</a>
    <a href="/search?q=hello">Search</a>
    <a href="/api/ping?host=localhost">Ping host</a>
    <a href="/api/order?id=1">Order 1</a>
    <a href="/admin/users?role=user">Admin user management</a>
    <a href="/login">Login OTP</a>
    <a href="/wallet">Wallet passcode</a>
    <script>
      fetch('/api/avatar/upload');
      fetch('/download?file=public.txt');
      fetch('/search?q=hello');
      fetch('/api/ping?host=localhost');
      fetch('/api/cart?quantity=1');
      fetch('/api/order?id=1');
      fetch('/api/order/pay?order_id=1001&amount=10');
      fetch('/api/order/refund?order_id=1001&amount=10');
      fetch('/api/order/cancel?order_id=1001');
      fetch('/admin/users?role=user');
      fetch('/api/auth/send-sms-code');
      fetch('/api/auth/verify-code?code=123456');
      fetch('/api/wallet/withdraw?amount=10&passcode=123456');
    </script>`);
  if(req.method==='GET' && url.pathname==='/profile') return send(res,200,`<title>User Profile Avatar</title><h2>头像上传 Avatar Upload</h2><form method="POST" action="/api/avatar/upload" enctype="multipart/form-data"><input name="avatar" type="file"><input name="display_name" value="alice"><button>Upload</button></form>`);
  if(req.method==='GET' && url.pathname==='/community') return send(res,200,`<title>Community Image Upload</title><form method="POST" action="/api/community/image/upload" enctype="multipart/form-data"><input name="image" type="file"><button>发图</button></form>`);
  if(req.method==='GET' && url.pathname==='/orders') return send(res,200,`<title>Orders</title><a href="/api/order?id=1">My order</a><a href="/api/order?id=2">Other order</a><form method="GET" action="/api/cart"><input name="quantity" value="1"><button>cart</button></form>`);
  if(req.method==='GET' && url.pathname==='/login') return send(res,200,`<title>Login OTP</title><form method="POST" action="/api/auth/send-sms-code"><input name="mobile" value="13800000000"><button>Send SMS code</button></form><form method="POST" action="/api/auth/verify-code"><input name="mobile" value="13800000000"><input name="code" value="123456"><button>Verify</button></form>`);
  if(req.method==='GET' && url.pathname==='/wallet') return send(res,200,`<title>Wallet Withdraw</title><form method="POST" action="/api/wallet/withdraw"><input name="amount" value="10"><input name="passcode" value="123456"><button>Withdraw</button></form>`);
  if(req.method==='POST' && ['/api/avatar/upload','/api/community/image/upload'].includes(url.pathname)) {
    return parseMultipart(req, req.headers['content-type']||'', (_e, parts)=>{
      const file=parts.find(p=>p.filename) || {filename:'upload.bin', contentType:'application/octet-stream', body:Buffer.from('')};
      const safeName=file.filename.replace(/^.*[\\/]/,'');
      uploads.set(safeName, {contentType:file.contentType, body:file.body});
      return json(res,200,{ok:true, avatar_url:'/uploads/'+safeName, url:'/uploads/'+safeName, path:'/uploads/'+safeName, filename:file.filename});
    });
  }
  if(req.method==='GET' && url.pathname.startsWith('/uploads/')) { const name=decodeURIComponent(url.pathname.split('/').pop()); const file=uploads.get(name); if(!file) return send(res,404,'missing'); res.writeHead(200, {'content-type':file.contentType}); return res.end(file.body); }
  if(req.method==='GET' && url.pathname==='/download') { const f=url.searchParams.get('file')||''; if(f.includes('..') || f.includes('etc/passwd')) return send(res,200,'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin', {'content-type':'text/plain'}); return send(res,200,'public report file', {'content-type':'text/plain'}); }
  if(req.method==='GET' && url.pathname==='/search') { const q=url.searchParams.get('q')||''; return send(res,200,`<title>Search</title><div id="result">${q}</div>`); }
  if(req.method==='GET' && url.pathname==='/api/ping') { const h=url.searchParams.get('host')||''; if(/[;|`$]/.test(h)) return send(res,200,'PING localhost\nuid=1000(bstg) gid=1000(bstg) groups=1000(bstg)', {'content-type':'text/plain'}); return send(res,200,'PING '+h+' ok', {'content-type':'text/plain'}); }
  if(req.method==='GET' && url.pathname==='/api/order') { const id=url.searchParams.get('id')||'1'; if(id==='2') return json(res,200,{id:2, owner:'victim-bob', amount:999, secret:'other user order exposed'}); return json(res,200,{id:1, owner:'alice', amount:10}); }
  if(req.method==='GET' && url.pathname==='/api/order/pay') return json(res,200,{ok:true, order_id:url.searchParams.get('order_id')||'1001', status:'paid', race_window:true, message:'pay accepted'});
  if(req.method==='GET' && url.pathname==='/api/order/refund') return json(res,200,{ok:true, order_id:url.searchParams.get('order_id')||'1001', status:'refunded', refunded:true, message:'refund accepted during race'});
  if(req.method==='GET' && url.pathname==='/api/order/cancel') return json(res,200,{ok:true, order_id:url.searchParams.get('order_id')||'1001', status:'cancelled', cancelled:true, message:'cancel accepted during race'});
  if(req.method==='GET' && url.pathname==='/admin/users') { const role=url.searchParams.get('role') || 'user'; if(role==='admin' || role==='1' || role==='2') return json(res,200,{admin:true, users:[{id:1,email:'admin@example.com'}], message:'admin function accessible'}); return json(res,200,{admin:false,message:'user view'}); }
  if((req.method==='GET' || req.method==='POST') && url.pathname==='/api/auth/send-sms-code') return json(res,200,{ok:true, sms_sent:true, otp_ticket:'otp-ticket-1', message:'sms code sent'});
  if((req.method==='GET' || req.method==='POST') && url.pathname==='/api/auth/verify-code') { const code=url.searchParams.get('code')||''; if(['000000','123456',''].includes(code)) return json(res,200,{ok:true, verified:true, token:'login_success_token', message:'otp bypass accepted'}); return json(res,403,{ok:false,message:'bad code'}); }
  if((req.method==='GET' || req.method==='POST') && url.pathname==='/api/wallet/withdraw') { const passcode=url.searchParams.get('passcode')||''; if(['000000','123456',''].includes(passcode)) return json(res,200,{ok:true, passcode_verified:true, withdraw:'accepted', message:'passcode bypass accepted'}); return json(res,403,{ok:false,message:'bad passcode'}); }
  if(req.method==='GET' && url.pathname==='/api/cart') { const q=Number(url.searchParams.get('quantity')||'1'); if(q < 0) return json(res,200,{ok:true, quantity:q, total:-100, message:'negative quantity accepted'}); return json(res,200,{ok:true, quantity:q, total:q*100}); }
  send(res,404,'not found');
});
server.listen(port, '127.0.0.1', () => console.log(`vuln-target http://127.0.0.1:${port}`));
