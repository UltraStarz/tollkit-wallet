/** The dashboard page. One file, no outside scripts, fonts or images. */
import { COIN_ICONS } from "./coin-icons.js";
import { AI_ICONS } from "./ai-icons.js";
const COIN_JSON = JSON.stringify(COIN_ICONS).replace(/</g, "\\u003c");
const AI_ICON_JSON = JSON.stringify(AI_ICONS).replace(/</g, "\\u003c");
export const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tollkit Wallet</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='20' fill='%230a0a0a'/%3E%3Ctext x='50' y='68' font-family='ui-monospace,SFMono-Regular,monospace' font-size='56' font-weight='700' fill='%234a8eff' text-anchor='middle'%3Et%3C/text%3E%3C/svg%3E">
<style>
:root{--bg:#0d0e12;--card:#16171d;--surf:#1e2027;--surf2:#262934;--line:#2c2f3a;--tx:#f1f2f6;--mut:#979aab;--acc:#4a8eff;--acc2:#3a7bea;--ok:#3ccf91;--bad:#ff6b6b;--warn:#f5b84a}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]){--bg:#eceef3;--card:#fff;--surf:#f4f5f8;--surf2:#e9ebf1;--line:#e1e3ea;--tx:#15161b;--mut:#666a7a}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif}
.wrap{max-width:420px;margin:24px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;min-height:640px}
header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}
.logo{width:30px;height:30px;flex:none;display:block}
.brand{font:700 15px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.01em;white-space:nowrap}.brand .dot{color:#4a8eff}.brand .sub{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-weight:500;color:var(--mut);margin-left:6px}
.cp{margin-left:auto;flex:none;border:0;background:var(--surf2);color:var(--tx);border-radius:9px;padding:6px 10px;font:600 12px inherit;cursor:pointer;display:flex;align-items:center;gap:5px}
.cp svg{width:14px;height:14px}.cp.done{color:var(--ok)}header .pill{margin-left:auto;white-space:nowrap;font-size:11px;padding:4px 9px;border-radius:99px;background:var(--surf);color:var(--mut)}
main{flex:1;padding:16px;overflow:auto}
nav{display:grid;grid-template-columns:repeat(6,1fr);border-top:1px solid var(--line);background:var(--card)}
nav button{background:none;border:0;color:var(--mut);padding:10px 0 12px;font:inherit;font-size:11px;cursor:pointer;position:relative}
nav button svg{display:block;margin:0 auto 3px;width:20px;height:20px}
nav button.on{color:var(--acc)}
.badge{position:absolute;top:5px;left:calc(50% + 6px);background:var(--bad);color:#fff;border-radius:99px;font-size:10px;padding:0 5px;min-width:16px}
.big{font-size:34px;font-weight:700;letter-spacing:-.5px;margin:6px 0 2px}
.mut{color:var(--mut)}.sm{font-size:12px}
.row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surf);border-radius:12px;margin-top:8px}
.row .r{margin-left:auto;text-align:right}
.chip{font-size:11px;padding:2px 8px;border-radius:99px;background:var(--surf2);color:var(--mut)}
.ic{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;flex:none;background:var(--surf2)}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:18px 0 4px;font-weight:600}
.bar{height:6px;background:var(--surf2);border-radius:99px;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:var(--acc)}
button.b{border:0;border-radius:12px;padding:11px 14px;font:inherit;font-weight:600;cursor:pointer;background:var(--acc2);color:#fff}
button.b.g{background:var(--surf2);color:var(--tx)}button.b.ok{background:var(--ok);color:#06231a}button.b.no{background:var(--surf2);color:var(--bad)}
button.b:disabled{opacity:.5;cursor:default}
.addr{font:12px ui-monospace,Menlo,monospace;word-break:break-all}
label{display:block;font-size:12px;color:var(--mut);margin:10px 0 4px}
input,select{width:100%;background:var(--surf);border:1px solid var(--line);color:var(--tx);border-radius:10px;padding:10px;font:inherit}
input:focus,select:focus{outline:2px solid var(--acc);border-color:transparent}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.msg{margin-top:10px;font-size:13px;padding:9px 11px;border-radius:10px;background:var(--surf)}.msg.err{color:var(--bad)}.msg.okk{color:var(--ok)}
.ap{background:var(--surf);border:1px solid var(--acc);border-radius:14px;padding:12px;margin-top:10px;white-space:pre-wrap}
.ap .btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.empty{text-align:center;color:var(--mut);padding:40px 10px}
a{color:var(--acc)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.toggles{display:flex;gap:6px;flex-wrap:wrap}.toggles label{display:flex;align-items:center;gap:6px;margin:0;padding:8px 10px;background:var(--surf);border-radius:10px;color:var(--tx);font-size:13px}
.toggles input{width:auto}

/* ── Motion, in the same language as tollkit.dev (motion.css) ─────────── */
:root{--ease:cubic-bezier(.16,1,.3,1);--glow:74,142,255}
body{min-height:100vh;overflow-x:hidden}
.aur{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.aur .drift{position:absolute;inset:-10%;transition:transform 1.2s var(--ease);will-change:transform}
.aur i{position:absolute;border-radius:50%;filter:blur(72px);width:62vmax;height:62vmax;max-width:860px;max-height:860px;will-change:transform}
.aur i:nth-child(1){background:radial-gradient(circle,rgba(47,107,255,.5),transparent 62%);top:-28%;left:-22%;animation:tk-a 24s ease-in-out infinite alternate}
.aur i:nth-child(2){background:radial-gradient(circle,rgba(122,77,255,.36),transparent 62%);top:-32%;right:-24%;animation:tk-b 28s ease-in-out infinite alternate}
.aur i:nth-child(3){background:radial-gradient(circle,rgba(25,194,160,.2),transparent 62%);bottom:-30%;left:20%;width:44vmax;height:44vmax;animation:tk-c 32s ease-in-out infinite alternate}
.aur::after{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:48px 48px;-webkit-mask-image:radial-gradient(ellipse 60% 55% at 50% 30%,#000 15%,transparent 70%);mask-image:radial-gradient(ellipse 60% 55% at 50% 30%,#000 15%,transparent 70%)}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]) .aur i{opacity:.55}:root:not([data-theme=dark]) .aur::after{opacity:.5;filter:invert(1)}}
@keyframes tk-a{to{transform:translate(14%,10%) scale(1.12)}}
@keyframes tk-b{to{transform:translate(-12%,14%) scale(.92)}}
@keyframes tk-c{to{transform:translate(-18%,-8%) scale(1.2)}}
.wrap{position:relative;z-index:1}
.card{background:color-mix(in srgb,var(--card) 84%,transparent);-webkit-backdrop-filter:blur(18px) saturate(140%);backdrop-filter:blur(18px) saturate(140%);box-shadow:0 40px 100px -30px rgba(0,0,0,.65),0 0 0 1px rgba(255,255,255,.03) inset}
nav{background:transparent}
@keyframes tk-rise{from{opacity:0;transform:translateY(14px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
@keyframes tk-card{from{opacity:0;transform:translateY(24px) scale(.97);filter:blur(10px)}to{opacity:1;transform:none;filter:none}}
.m .card{animation:tk-card 1s var(--ease) both}
.m header>*{animation:tk-rise .9s var(--ease) both;animation-delay:calc(var(--i,0)*90ms + 250ms)}
.m main.enter>*{animation:tk-rise .7s var(--ease) both;animation-delay:calc(var(--i,0)*45ms)}
.m .brand .dot{background:linear-gradient(100deg,#4a8eff 20%,#a98bff 40%,#6fe0c8 50%,#4a8eff 70%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:tk-sheen 7s linear infinite}
@keyframes tk-sheen{from{background-position:100% 0}to{background-position:-150% 0}}
.logo{transition:transform .5s var(--ease),filter .5s ease}.m header:hover .logo{transform:rotate(-8deg) scale(1.08);filter:drop-shadow(0 6px 16px rgba(var(--glow),.55))}
.pill.live{display:flex;align-items:center;gap:6px}.pill.live::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 rgba(60,207,145,.6)}
.m .pill.live::before{animation:tk-breathe 2.4s ease-out infinite}
@keyframes tk-breathe{0%{box-shadow:0 0 0 0 rgba(60,207,145,.55)}70%,100%{box-shadow:0 0 0 7px rgba(60,207,145,0)}}
.big{background:linear-gradient(180deg,var(--tx) 30%,color-mix(in srgb,var(--tx) 70%,var(--acc)));-webkit-background-clip:text;background-clip:text;color:transparent;font-variant-numeric:tabular-nums}
.row{position:relative;isolation:isolate}
.m .row,.m .ap{transition:transform .4s var(--ease),background .2s ease,box-shadow .4s ease}
.m .row:hover{transform:translateY(-2px);box-shadow:0 16px 44px -24px rgba(var(--glow),.6)}
.spot::before,.spot::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .35s ease}
.spot::before{z-index:-1;background:radial-gradient(300px circle at var(--mx,50%) var(--my,50%),rgba(var(--glow),.12),transparent 45%)}
.spot::after{padding:1px;background:radial-gradient(200px circle at var(--mx,50%) var(--my,50%),rgba(var(--glow),.8),transparent 60%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}
.m .spot:hover::before,.m .spot:hover::after{opacity:1}
.ic{transition:transform .45s var(--ease),box-shadow .45s ease}.m .row:hover .ic{transform:rotate(-6deg) scale(1.08);box-shadow:0 6px 20px -6px rgba(var(--glow),.6)}
.bar i{width:0;background:linear-gradient(90deg,#4a8eff,#8b7bff,#6fe0c8);background-size:200% 100%;transition:width 1.2s var(--ease);position:relative;border-radius:99px}
.m .bar i{animation:tk-flow 4s linear infinite}
@keyframes tk-flow{from{background-position:0 0}to{background-position:-200% 0}}
.b{position:relative;overflow:hidden;isolation:isolate;transition:transform .18s var(--ease),box-shadow .3s ease,background .2s ease}
.m .b:active{transform:scale(.965)}
.b:not(.g):not(.no)::after{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.28) 50%,transparent 70%);transform:translateX(-120%)}
.m .b:not(.g):not(.no):hover::after{transform:translateX(120%);transition:transform .9s var(--ease)}
.m .b:not(.g):not(.no):hover{box-shadow:0 10px 30px -10px rgba(var(--glow),.7)}
.m .b.ok:hover{box-shadow:0 10px 30px -10px rgba(60,207,145,.7)}
nav{position:relative}
.ind{position:absolute;top:-1px;left:0;width:16.6667%;height:2px;display:flex;justify-content:center;pointer-events:none;transition:transform .55s var(--ease)}
.ind::before{content:"";width:34px;height:2px;border-radius:2px;background:var(--acc);box-shadow:0 0 14px 1px rgba(var(--glow),.85)}
nav button svg{transition:transform .45s var(--ease)}nav button.on svg{transform:translateY(-2px) scale(1.1)}
nav button:not(.on):hover{color:var(--tx)}
.m .badge{animation:tk-pop .6s var(--ease)}
@keyframes tk-pop{0%{transform:scale(0)}55%{transform:scale(1.3)}100%{transform:scale(1)}}
.m .ap{animation:tk-glow 2.6s ease-in-out infinite}
@keyframes tk-glow{0%,100%{box-shadow:0 0 0 0 rgba(var(--glow),0)}50%{box-shadow:0 0 0 1px rgba(var(--glow),.35),0 0 32px -6px rgba(var(--glow),.55)}}
.m .msg{animation:tk-rise .5s var(--ease) both}
.cp svg{transition:transform .35s var(--ease)}.cp.done svg{transform:scale(1.2) rotate(-8deg)}
input,select{transition:border-color .2s ease,box-shadow .25s ease}input:focus,select:focus{box-shadow:0 0 0 4px rgba(var(--glow),.18)}
.skel{display:inline-block;height:34px;width:150px;border-radius:10px;background:linear-gradient(90deg,var(--surf) 20%,var(--surf2) 40%,var(--surf) 60%);background-size:250% 100%;animation:tk-skel 1.4s ease-in-out infinite;vertical-align:middle}
@keyframes tk-skel{from{background-position:100% 0}to{background-position:-150% 0}}
.ic.tok{position:relative;background:none;overflow:visible}
.ic.tok>svg{width:32px;height:32px;border-radius:50%;display:block;box-shadow:0 0 0 1px rgba(255,255,255,.06)}
.ic.tok .glyph{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--surf2)}
.cb{position:absolute;right:-4px;bottom:-4px;width:16px;height:16px;border-radius:50%;overflow:hidden;box-shadow:0 0 0 2px var(--surf);transition:transform .45s var(--ease)}
.cb svg{width:100%;height:100%;display:block}
.m .row:hover .cb{transform:scale(1.12)}
.conf{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 8px 2px 3px;border-radius:99px;background:var(--surf2);color:var(--mut);white-space:nowrap;vertical-align:middle}
.conf.final{color:var(--ok)}.conf.failed{color:var(--bad)}.conf.confirmed{color:var(--tx)}
.ring{width:16px;height:16px;flex:none}.m .ring.spin{animation:tk-spin 2.4s linear infinite}
@keyframes tk-spin{to{transform:rotate(360deg)}}
.livedot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ok);margin-left:4px;vertical-align:middle}.m .livedot{animation:tk-breathe 2s ease-out infinite}
.m .row.live-pending{animation:tk-glow 2.6s ease-in-out infinite}
#toasts{position:absolute;left:12px;right:12px;top:62px;z-index:5;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.card{position:relative}
.toast{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:color-mix(in srgb,var(--surf2) 92%,transparent);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid rgba(var(--glow),.45);box-shadow:0 18px 40px -16px rgba(0,0,0,.6),0 0 30px -10px rgba(var(--glow),.6);pointer-events:auto}
.toast.in{border-color:rgba(60,207,145,.55);box-shadow:0 18px 40px -16px rgba(0,0,0,.6),0 0 30px -10px rgba(60,207,145,.6)}
.m .toast{animation:tk-toast .7s var(--ease) both}.m .toast.out{animation:tk-toast-out .5s ease both}
@keyframes tk-toast{from{opacity:0;transform:translateY(-14px) scale(.96);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
@keyframes tk-toast-out{to{opacity:0;transform:translateY(-10px) scale(.97)}}

.tname{font-weight:600}
.usdv{font-weight:700;font-size:15px;font-variant-numeric:tabular-nums;border-radius:6px;padding:0 3px;margin-right:-3px}
.m .usdv.up{animation:tk-up 1.2s ease}.m .usdv.down{animation:tk-down 1.2s ease}
@keyframes tk-up{0%{background:rgba(60,207,145,.28);color:var(--ok)}100%{background:transparent}}
@keyframes tk-down{0%{background:rgba(255,107,107,.25);color:var(--bad)}100%{background:transparent}}
.daychg{margin:2px 0 10px}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
.aib{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-top:14px;background:linear-gradient(135deg,var(--acc),var(--acc2));box-shadow:0 6px 24px rgba(var(--glow),.25)}
.aib:hover{transform:translateY(-1px);box-shadow:0 10px 32px rgba(var(--glow),.38)}
.aiconn{display:flex;gap:8px;margin-top:14px;align-items:stretch}
.aich{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--surf);border:1px solid var(--line);border-radius:14px;color:var(--tx);font:inherit;cursor:pointer;text-align:left;transition:border-color .15s,transform .2s var(--ease)}
.aich:hover{border-color:var(--acc);transform:translateY(-1px)}
.aistk{display:flex;flex:none}.aistk i{width:30px;height:30px;border-radius:50%;background:var(--surf2);border:2px solid var(--surf);display:flex;align-items:center;justify-content:center;margin-left:-8px}.aistk i:first-child{margin-left:0}
.aistk svg{width:16px;height:16px;margin:0}.ail-claude{color:#d97757}
.aichn{min-width:0;display:flex;flex-direction:column}.aichn b{font-size:13.5px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.aichn small{font-size:11.5px;color:var(--mut)}
.aiap{flex:none;display:flex;align-items:center;gap:7px;padding:0 16px;border-radius:14px;background:linear-gradient(135deg,var(--acc),var(--acc2));box-shadow:0 6px 24px rgba(var(--glow),.25)}.aiap svg{margin:0}
.aiap:hover{transform:translateY(-1px);box-shadow:0 10px 32px rgba(var(--glow),.38)}
.aiwt{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#fff;color:var(--acc2);font-size:11px;display:inline-flex;align-items:center;justify-content:center}
.aiic{display:inline-flex}.aiic svg{width:16px;height:16px;margin-left:-3px;padding:2px;border-radius:50%;background:rgba(0,0,0,.25)}
.aio{position:fixed;inset:0;z-index:50;background:rgba(5,6,9,.72);backdrop-filter:blur(6px);display:flex;align-items:flex-start;justify-content:center;padding:5vh 16px 16px;animation:aifade .25s ease}
.aidlg{position:relative;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:22px 20px 18px;box-shadow:0 30px 90px rgba(0,0,0,.6);animation:tk-rise .5s var(--ease) both}
.aidlg h2{margin:0 0 4px;font-size:19px;letter-spacing:-.01em}
.aix{position:absolute;top:10px;right:10px;width:34px;height:34px;border-radius:10px;border:1px solid transparent;background:none;color:var(--mut);font-size:22px;line-height:1;cursor:pointer}.aix:hover{border-color:var(--line);color:var(--tx)}
.ailead{color:var(--mut);font-size:14px;margin:0 0 14px;line-height:1.5}
.ailbl{display:block;font-size:12px;font-weight:600;color:var(--mut);margin-bottom:5px}
.aiin{width:100%;background:var(--surf);border:1px solid var(--line);color:var(--tx);border-radius:11px;padding:11px 12px;font:inherit}
.aiin:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px rgba(var(--glow),.18)}
.aismall{font-size:12px;color:var(--mut);margin:6px 0 14px;line-height:1.45}
.ailist{display:flex;flex-direction:column;gap:8px}
.airow{background:var(--surf);border:1px solid var(--line);border-radius:14px;padding:11px 12px 8px;animation:tk-rise .5s var(--ease) both;animation-delay:calc(var(--i)*40ms)}
.airt{display:flex;align-items:center;gap:11px}.airt>svg{width:24px;height:24px;flex:none}
.ainm{flex:1;min-width:0;display:flex;flex-direction:column}.ainm b{font-size:14.5px}.ainm small{font-size:12px;color:var(--mut)}
.aiadd{padding:8px 16px;border-radius:10px;font-size:13.5px;text-decoration:none;flex:none}a.aiadd{display:inline-block;background:var(--acc2);color:#fff;font-weight:600}.aiadd[disabled]{opacity:.6;cursor:default}
.aim{font-size:12.5px;margin:7px 0 0 35px}
.aihand{background:none;border:0;padding:4px 0 0 35px;color:var(--mut);font:inherit;font-size:12px;cursor:pointer}.aihand:hover{color:var(--tx)}
.aihb{margin:6px 0 4px 35px}
.aip{font-size:13px;margin:6px 0}.aisml2{padding:5px 10px;font-size:12.5px;text-decoration:none;display:inline-block}
.aist{margin:0 0 4px;padding-left:18px;font-size:13px;line-height:1.55}.aist li{margin:5px 0}
.aidlg code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;color:var(--acc);overflow-wrap:anywhere}
.kbd{font-family:ui-monospace,monospace;font-size:.85em;background:var(--surf2);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.aicmd{display:flex;gap:8px;align-items:flex-start;background:#08090c;border:1px solid var(--line);border-radius:12px;padding:9px 9px 9px 13px;margin:8px 0}
.aicmd pre{flex:1;min-width:0;margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cdd6e4;white-space:pre-wrap;overflow-wrap:anywhere}
.aicp{padding:6px 11px;font-size:12.5px;border-radius:9px}
.aigoap{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:14px;background:linear-gradient(135deg,var(--acc),var(--acc2))}.aigoap svg{margin:0}
.aidone{margin-top:16px;padding-top:13px;border-top:1px solid var(--line);font-size:13px;color:var(--mut);line-height:1.5}.aidone b{color:var(--tx)}
@keyframes aifade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.aio,.aidlg,.airow{animation:none}}
.tc-chat{background:var(--surf);border:1px solid var(--line);border-radius:18px;margin-top:12px;overflow:hidden}
.tc-chd{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 12px;border-bottom:1px solid var(--line)}
.tc-chn{display:flex;align-items:center;gap:9px;min-width:0}.tc-chn>svg{width:22px;height:22px;flex:none;color:#d97757}.tc-chn b{display:block;font-size:14px}.tc-chn small{display:block;font-size:11.5px;color:var(--mut)}
.tc-chr{display:flex;align-items:center;gap:6px}.tc-chk{display:flex;align-items:center;gap:4px;color:var(--mut)}
.tc-chk select{max-width:130px;background:var(--surf2);color:var(--tx);border:1px solid var(--line);border-radius:9px;padding:5px 6px;font:inherit;font-size:12px}
.tc-chx{width:32px;height:32px;padding:0;border-radius:9px;display:flex;align-items:center;justify-content:center;flex:none;font-size:20px;font-weight:500;line-height:1}.tc-csend svg{margin:0}
.tc-cbody{position:relative;max-height:min(58vh,520px);min-height:180px;overflow-y:auto;padding:14px 12px 6px;display:flex;flex-direction:column;gap:12px}
.tc-cm{display:flex;gap:8px}.tc-cm.tc-new{animation:tk-rise .45s var(--ease) both}.tc-cm.tc-you{justify-content:flex-end}
.tc-cm.tc-you .tc-cb{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;border-radius:16px 16px 4px 16px;max-width:82%}
.tc-cav{width:26px;height:26px;border-radius:50%;background:var(--surf2);display:flex;align-items:center;justify-content:center;flex:none;color:#d97757}.tc-cav svg{width:15px;height:15px}
.tc-cbw{min-width:0;flex:1;max-width:92%}
.tc-cb{padding:9px 12px;font-size:14px;line-height:1.5;border-radius:16px 16px 16px 4px;background:var(--card);border:1px solid var(--line);overflow-wrap:anywhere}
.tc-cm.tc-you .tc-cb{border:0}.tc-cb p{margin:0 0 7px}.tc-cb p:last-child{margin:0}.tc-cb ul{margin:0 0 7px;padding-left:18px}.tc-cb li{margin:2px 0}.tc-cb code{font-family:ui-monospace,monospace;font-size:.9em}
.tc-cm.tc-err .tc-cb{border-color:rgba(255,107,107,.45);color:var(--bad)}
.tc-ctag{font-size:11px;color:var(--mut);margin:0 0 4px 2px}
.tc-ccards{margin-top:8px;display:flex;flex-direction:column;gap:8px}.tc-ccards .row{margin:0;background:var(--card)}
.tc-cq{display:flex;align-items:center;justify-content:center;gap:5px;font-size:11.5px;color:var(--mut);text-align:center}
.tc-cempty{padding:22px 12px;text-align:center}.tc-cempty b{font-size:15px}.tc-cempty p{color:var(--mut);font-size:13.5px;line-height:1.5;margin:6px auto 12px;max-width:380px}
.tc-cchips{display:flex;flex-wrap:wrap;gap:7px;justify-content:center}
.tc-cchip{border:1px solid var(--line);background:var(--card);color:var(--tx);border-radius:99px;padding:7px 12px;font:inherit;font-size:12.5px;cursor:pointer;transition:border-color .15s,transform .2s var(--ease)}.tc-cchip:hover{border-color:var(--acc);transform:translateY(-1px)}
.tc-ctyping{display:inline-flex;align-items:center;gap:4px;color:var(--mut);font-size:12.5px}.tc-ctyping span{margin-left:6px}
.tc-ctyping i{width:6px;height:6px;border-radius:50%;background:var(--mut);animation:cdot 1.2s infinite ease-in-out}.tc-ctyping i:nth-child(2){animation-delay:.15s}.tc-ctyping i:nth-child(3){animation-delay:.3s}
@keyframes cdot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
.tc-cpw{margin:0 12px 10px;padding:10px 11px;border-radius:12px;background:rgba(245,184,74,.1);border:1px solid rgba(245,184,74,.4)}
.tc-crow{display:flex;gap:8px;margin-top:8px}.tc-crow input{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);color:var(--tx);border-radius:10px;padding:9px 10px;font:inherit}
.tc-cin{display:flex;gap:8px;align-items:flex-end;padding:10px 12px 12px;border-top:1px solid var(--line)}
.tc-cin textarea{flex:1;resize:none;background:var(--card);border:1px solid var(--line);color:var(--tx);border-radius:14px;padding:10px 12px;font:inherit;font-size:14px;line-height:1.4;max-height:140px}
.tc-cin textarea:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px rgba(var(--glow),.18)}
.tc-csend{width:42px;height:42px;padding:0;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none}.tc-csend[disabled]{opacity:.45;cursor:default}
.tc-why{font-size:12.5px;color:var(--tx);opacity:.85;margin-top:5px;line-height:1.45}
.mrule summary{cursor:pointer;color:var(--mut);font-size:13px;margin-top:14px}
@media (prefers-reduced-motion:reduce){.tc-cm.tc-new{animation:none}.tc-ctyping i{animation:none}}
</style></head><body>
<div class="aur" aria-hidden="true"><div class="drift"><i></i><i></i><i></i></div></div>
<div class="wrap"><div class="card">
<header><svg style="--i:0" class="logo" viewBox="0 0 100 100" aria-hidden="true"><rect x="1.5" y="1.5" width="97" height="97" rx="20" fill="#0a0a0a" stroke="#2f3442" stroke-width="3"/><text x="50" y="68" font-family="ui-monospace,SFMono-Regular,monospace" font-size="56" font-weight="700" fill="#4a8eff" text-anchor="middle">t</text></svg><span class="brand" style="--i:1">Toll<span class="dot">kit</span><span class="sub">Wallet</span></span><span class="pill" style="--i:2" id="appr">…</span></header>
<div id="toasts" aria-live="polite"></div><main id="main"><div class="empty">Loading…</div></main>
<nav id="nav"></nav>
</div><p class="mut sm" style="text-align:center">Running on this computer only. Keys never leave it.</p></div>
<script>
var RM=matchMedia("(prefers-reduced-motion: reduce)").matches;if(!RM)document.documentElement.classList.add("m");
var T=new URLSearchParams(location.search).get("t");history.replaceState(null,"","/");
var S=null,B=null,tab="home",flash=null;
var EXP={base:"https://basescan.org/tx/",ethereum:"https://etherscan.io/tx/",solana:"https://solscan.io/tx/"};
var TOK={base:["USDC","ETH"],ethereum:["USDC","USDT","ETH"],solana:["USDC","USDT","SOL"]};
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function api(p,body){return fetch("/api"+p,{method:body?"POST":"GET",headers:{"x-tw-token":T,"content-type":"application/json"},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j})})}
function short(a){a=String(a||"");return a.length>14?a.slice(0,a.indexOf("0x")===0?6:4)+"…"+a.slice(-4):a}
var COIN=${COIN_JSON};
var AIIC=${AI_ICON_JSON},AIO=null,AIPW="",AIMSG={},AIOPEN={},AIBUSY=null;
function aiSvg(k){var i=AIIC[k];return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor"'+(i.rule?' fill-rule="'+i.rule+'"':'')+' d="'+i.d+'"/></svg>'}
var AIMETA={claude:["claude","Claude"],"claude-code":["claude","Claude Code"],cursor:["cursor","Cursor"],vscode:["copilot","VS Code"],codex:["terminal","Codex"],gemini:["gemini","Gemini CLI"]};
function aiBtn(){var on=((S.connect||{}).apps||[]).filter(function(a){return a.added});
if(!on.length)return '<button class="b aib" onclick="openAI()"><span class="aiic">'+aiSvg("claude")+aiSvg("cursor")+aiSvg("gemini")+'</span>Connect your AI</button>';
var icons=[],names=[];on.forEach(function(a){var m=AIMETA[a.id];if(!m)return;names.push(m[1]);if(icons.indexOf(m[0])<0)icons.push(m[0])});
var wait=(S.rules||[]).filter(function(r){return r.status==="proposed"}).length;
return '<div class="aiconn"><button class="aich" onclick="openAI()" title="Manage connected AI apps"><span class="aistk">'+icons.slice(0,4).map(function(k){return '<i class="ail-'+k+'">'+aiSvg(k)+'</i>'}).join("")+'</span><span class="aichn"><b>'+esc(names.join(" + "))+'</b><small><span class="ok">●</span> Connected</small></span></button>'+
'<button class="b aiap" onclick="goAuto()"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>Autopilot'+(wait?'<span class="aiwt">'+wait+'</span>':'')+'</button></div>'}
function goAuto(){go("autopilot");setTimeout(function(){var t=document.getElementById("chin");if(t&&!t.disabled)t.focus()},120)}
function aiCfg(){var c=S.connect||{};return c.launch||{command:"npx",args:["-y","tollkit-wallet","mcp"],env:{TOLLKIT_WALLET_PASSWORD_FILE:c.password_file||""}}}
function shq(s){s=String(s);if(/^[\w@%+=:,.\/-]+$/.test(s))return s;return (S.connect&&S.connect.windows)?'"'+s.replace(/"/g,'\\"')+'"':"'"+s.replace(/'/g,"'\\''")+"'"}
function aiEnv(flag){var e=aiCfg().env;return Object.keys(e).map(function(k){return flag+" "+shq(k+"="+e[k])}).join(" ")}
function aiCmd(){var c=aiCfg();return [c.command].concat(c.args).map(shq).join(" ")}
function aiJson(key,extra){var c=aiCfg(),o={};o[key]={};o[key]["tollkit-wallet"]=extra?Object.assign({},extra,c):c;return JSON.stringify(o,null,2)}
function aiCode(id,t){return '<div class="aicmd"><pre id="'+id+'">'+esc(t)+'</pre><button class="b g aicp" data-copy="'+id+'">Copy</button></div>'}
function b64u(s){try{return btoa(unescape(encodeURIComponent(s)))}catch(e){return btoa(s)}}
// Steps checked against each app's docs or the app itself on 2026-10-14. Change only with a source.
var AIAPPS=[
{id:"claude",name:"Claude",sub:"Desktop app",icon:"claude",hand:function(){return '<ol class="aist"><li>In the menu bar, click <b>Claude → Settings…</b>, open <b>Developer</b> and click <b>Edit Config</b>.</li><li>Put this in the file. If it already has <code>"mcpServers"</code>, add just the <code>"tollkit-wallet"</code> entry:</li></ol>'+aiCode("ai-cd",aiJson("mcpServers"))+'<ol class="aist" start="3"><li>Quit Claude completely and open it again.</li></ol>'}},
{id:"claude-code",name:"Claude Code",sub:"Terminal",icon:"claude",hand:function(){return '<p class="aip">Paste into your terminal:</p>'+aiCode("ai-cc","claude mcp add "+aiEnv("--env")+" --transport stdio --scope user tollkit-wallet -- "+aiCmd())}},
{id:"cursor",name:"Cursor",sub:"Code editor",icon:"cursor",hand:function(){var link="cursor://anysphere.cursor-deeplink/mcp/install?name=tollkit-wallet&config="+encodeURIComponent(b64u(JSON.stringify(aiCfg())));return '<p class="aip"><a class="b g aisml2" href="'+esc(link)+'">Open in Cursor</a> or add this to <span class="kbd">~/.cursor/mcp.json</span> and restart Cursor:</p>'+aiCode("ai-cu",aiJson("mcpServers"))}},
{id:"vscode",name:"VS Code",sub:"With GitHub Copilot",icon:"copilot",hand:function(){return '<p class="aip">Run <b>MCP: Open User Configuration</b> from the Command Palette and add:</p>'+aiCode("ai-vs",aiJson("servers",{type:"stdio"}))}},
{id:"codex",name:"Codex",sub:"OpenAI’s terminal agent",icon:"terminal",hand:function(){return '<p class="aip">Paste into your terminal:</p>'+aiCode("ai-cx","codex mcp add tollkit-wallet "+aiEnv("--env")+" -- "+aiCmd())}},
{id:"gemini",name:"Gemini CLI",sub:"Terminal",icon:"gemini",hand:function(){var c=aiCfg();return '<p class="aip">Paste into your terminal:</p>'+aiCode("ai-gm","gemini mcp add -s user "+aiEnv("-e")+" tollkit-wallet "+shq(c.command)+" -- "+c.args.map(shq).join(" "))}}
];
function aiSt(id){var a=((S.connect||{}).apps||[]).filter(function(x){return x.id===id})[0];return a||{id:id,found:false,added:false,current:false,how:"file"}}
function aiRow(x,i){var st=aiSt(x.id),busy=AIBUSY===x.id,m=AIMSG[x.id],line,btn;
if(st.how==="link"){line='Opens VS Code to finish';btn='<a class="b aiadd" href="'+esc((S.connect||{}).vscode||"#")+'">Add</a>'}
else if(!st.found){line='Not found on this computer';btn=''}
else if(st.added&&st.current){line='<span class="ok">'+svgOk()+'Connected</span>';btn='<button class="b g aiadd" data-act="remove" data-id="'+x.id+'"'+(busy?" disabled":"")+'>'+(busy?"…":"Remove")+'</button>'}
else if(st.added){line='<span class="warn">Needs an update</span>';btn='<button class="b aiadd" data-act="add" data-id="'+x.id+'"'+(busy?" disabled":"")+'>'+(busy?"…":"Update")+'</button>'}
else{line='Found on this computer';btn='<button class="b aiadd" data-act="add" data-id="'+x.id+'"'+(busy?" disabled":"")+'>'+(busy?"Adding…":"Add")+'</button>'}
return '<div class="airow" style="--i:'+i+'"><div class="airt">'+aiSvg(x.icon)+'<div class="ainm"><b>'+esc(x.name)+'</b><small>'+line+'</small></div>'+btn+'</div>'+(m?'<div class="aim '+(m[0]?"ok":"bad")+'">'+esc(m[1])+'</div>':'')+'<button class="aihand" data-hand="'+x.id+'">'+(AIOPEN[x.id]?"Hide steps":"Do it by hand")+'</button>'+(AIOPEN[x.id]?'<div class="aihb">'+x.hand()+'</div>':'')+'</div>'}
function svgOk(){return '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
function aiRender(){if(!AIO)return;var c=S.connect||{},foc=document.activeElement&&document.activeElement.id==="aipw";
var h='<h2>Connect your AI</h2><p class="ailead">Let Claude, Cursor or another AI app use this wallet. It follows your limits, can’t withdraw or see your keys, and any rules it suggests wait in Autopilot for you.</p>'+
'<label class="ailbl" for="aipw">Wallet password</label><input id="aipw" class="aiin" type="password" autocomplete="current-password" placeholder="Needed to add an app" value="'+esc(AIPW)+'">'+
'<p class="aismall">'+(c.ready?'Your AI apps unlock the wallet with a saved copy of this password, readable only by your account on this computer.':'Adding an app saves a copy of this password on this computer, readable only by your account, so the app can unlock the wallet. Anyone who can read it and your wallet folder could spend within your limits.')+'</p>'+
'<div class="ailist">'+AIAPPS.map(aiRow).join("")+'</div>'+
(((S.connect||{}).apps||[]).some(function(a){return a.added})?'<button class="b aigoap" onclick="closeAI();goAuto()"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>Open Autopilot</button>':'')+'<div class="aidone"><b>Check it worked.</b> Ask your AI: <b>“What’s in my Tollkit wallet?”</b> Other apps: run <code>'+esc(aiCmd())+'</code> with <code>TOLLKIT_WALLET_PASSWORD_FILE</code> set.</div>';
var sc=AIO.querySelector(".aidlg").scrollTop;AIO.querySelector(".aibody").innerHTML=h;AIO.querySelector(".aidlg").scrollTop=sc;var pw=document.getElementById("aipw");pw.oninput=function(){AIPW=pw.value};if(foc)pw.focus()}
function openAI(){if(!AIO){AIO=document.createElement("div");AIO.className="aio";AIO.innerHTML='<div class="aidlg" role="dialog" aria-modal="true" aria-label="Connect your AI"><button class="aix" aria-label="Close">×</button><div class="aibody"></div></div>';AIO.addEventListener("mousedown",function(e){if(e.target===AIO)closeAI()});AIO.addEventListener("click",aiClick);document.body.appendChild(AIO)}aiRender();setTimeout(function(){var p=document.getElementById("aipw");if(p&&!AIPW)p.focus()},60)}
function closeAI(){if(AIO){AIO.remove();AIO=null;AIPW="";AIMSG={}}}
function aiDo(act,id){if(act!=="remove"&&!AIPW){AIMSG[id]=[0,"Type your wallet password first."];aiRender();document.getElementById("aipw").focus();return}
AIBUSY=id;AIMSG[id]=null;aiRender();api("/connect",{password:AIPW,action:act,app:id}).then(function(r){AIMSG[id]=[1,r.message];return refresh()}).catch(function(e){AIMSG[id]=[0,e.message]}).then(function(){AIBUSY=null;aiRender()})}
function aiClick(e){var t=e.target.closest("button,a");if(!t)return;if(t.classList.contains("aix"))closeAI();else if(t.hasAttribute("data-act"))aiDo(t.getAttribute("data-act"),t.getAttribute("data-id"));else if(t.hasAttribute("data-hand")){var k=t.getAttribute("data-hand");AIOPEN[k]=!AIOPEN[k];aiRender()}else if(t.hasAttribute("data-copy")){var el=document.getElementById(t.getAttribute("data-copy")),v=el?el.textContent:"",done=function(){t.textContent="Copied";setTimeout(function(){t.textContent="Copy"},1500)};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(done,function(){fallback(v);done()});else{fallback(v);done()}}}
document.addEventListener("keydown",function(e){if(AIO&&e.key==="Escape")closeAI()});
var LASTAP=null,CH={seen:null,n:-1,top:null,draft:"",pw:"",err:null,sending:false,manual:false},CHIPS=["Protect my ETH if the price drops hard","Buy SOL on dips, about $20 at a time","Set up a weekly buy I can stick with","How are my rules doing?"];
function fmtAi(t){var B=/^\s*([-•*]|\d+\.)\s+/,h=esc(t).replace(/\*\*([^*]+)\*\*/g,"<b>$1</b>").replace(/\x60([^\x60]+)\x60/g,"<code>$1</code>");return h.split(/\n{2,}/).map(function(p){var out="",ul=[],tx=[];function fT(){if(tx.length){out+='<p>'+tx.join("<br>")+'</p>';tx=[]}}function fU(){if(ul.length){out+='<ul>'+ul.map(function(l){return '<li>'+l+'</li>'}).join("")+'</ul>';ul=[]}}p.split("\n").forEach(function(l){if(B.test(l)){fT();ul.push(l.replace(B,""))}else{fU();tx.push(l)}});fT();fU();return out}).join("")}
function tm(ts){var d=new Date(ts);return d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})+(Date.now()-d>864e5?" · "+d.toLocaleDateString([],{month:"short",day:"numeric"}):"")}
function aiName(){var A=S.ai||{};return A.provider?A.provider.name:"AI"}
function ckey(m){return m.role==="you"?"y:"+m.text:(m.id||m.ts)}
function chatMsg(m){var nw=CH.seen&&!CH.seen[ckey(m)]?" tc-new":"";if(m.role==="you")return '<div class="tc-cm tc-you'+nw+'"><div class="tc-cb">'+esc(m.text).replace(/\n/g,"<br>")+'</div></div>';
if(m.checkin&&m.quiet&&!m.error)return '<div class="tc-cq">'+svgClock()+'Check-in '+tm(m.ts)+' · '+esc(m.text.replace(/^No changes[.:,]?\s*/i,"No changes. "))+'</div>';
var cards=(m.rules||[]).map(function(id){var r=(S.rules||[]).filter(function(x){return x.id===id})[0];return r?ruleCard(r):""}).join("");
return '<div class="tc-cm tc-ai'+nw+(m.error?" tc-err":"")+'"><div class="tc-cav">'+aiSvg("claude")+'</div><div class="tc-cbw">'+(m.checkin?'<div class="tc-ctag">Check-in · '+tm(m.ts)+'</div>':'')+'<div class="tc-cb">'+fmtAi(m.text)+'</div>'+(cards?'<div class="tc-ccards">'+cards+'</div>':'')+'</div></div>'}
function svgClock(){return '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'}
function chatBox(){var A=S.ai;if(!A)return "";var M=A.messages||[],busy=A.busy||CH.sending;
var head='<div class="tc-chd"><div class="tc-chn">'+aiSvg("claude")+'<div><b>'+esc(aiName())+'</b><small>'+(busy?'<span class="ok">Working…</span>':A.provider?'Your Claude, on this computer':'Not set up')+'</small></div></div>'+
'<div class="tc-chr"><label class="tc-chk" title="Let the AI review your rules on a schedule">'+svgClock()+'<select onchange="setCheckin(this.value)">'+[[0,"Check-ins off"],[1,"Every hour"],[4,"Every 4 hours"],[12,"Every 12 hours"],[24,"Daily"]].map(function(o){return '<option value="'+o[0]+'"'+(A.checkin.every_hours===o[0]?" selected":"")+'>'+o[1]+'</option>'}).join("")+'</select></label>'+(M.length?'<button class="b g tc-chx" onclick="newChat()" title="New chat" aria-label="New chat">+</button>':'')+'</div></div>';
if(!A.provider)return '<div class="tc-chat">'+head+'<div class="tc-cempty"><b>Chat with your AI here</b><p>Install <b>Claude Code</b> on this computer and sign in once (run <code>claude</code> in Terminal). Then reopen this page. It uses your own Claude plan; the wallet never sees your Claude login.</p></div></div>';
var body=M.length?M.map(chatMsg).join(""):'<div class="tc-cempty"><b>What do you want your autopilot to do?</b><p>Say it in your own words. '+esc(aiName())+' checks prices and your balances, then suggests rules you can turn on with one tap.</p><div class="tc-cchips">'+CHIPS.map(function(c,i){return '<button class="tc-cchip" onclick="chatSend(CHIPS['+i+'])">'+esc(c)+'</button>'}).join("")+'</div></div>';
if(busy)body+='<div class="tc-cm tc-ai"><div class="tc-cav">'+aiSvg("claude")+'</div><div class="tc-cbw"><div class="tc-cb tc-ctyping"><i></i><i></i><i></i><span>'+(A.busy&&A.busy.kind==="checkin"?"Checking in on your rules…":"Looking at prices and your wallet…")+'</span></div></div></div>';
var pw=!A.ready?'<div class="tc-cpw"><div class="sm">One time: your wallet password lets '+esc(aiName())+' read your balances. It’s saved on this computer, readable only by your account.</div><div class="tc-crow"><input id="chpw" type="password" placeholder="Wallet password" value="'+esc(CH.pw)+'" oninput="CH.pw=this.value"><button class="b" onclick="chatPw()">Save</button></div></div>':"";
var inp='<div class="tc-cin"><textarea id="chin" rows="1" placeholder="Message '+esc(aiName())+'…" oninput="CH.draft=this.value;grow(this)" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();chatSend()}"'+(A.ready?"":" disabled")+'>'+esc(CH.draft)+'</textarea><button class="b tc-csend" onclick="chatSend()"'+(busy||!A.ready?" disabled":"")+' aria-label="Send"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>';
return '<div class="tc-chat">'+head+'<div class="tc-cbody" id="cbody">'+body+'</div>'+(CH.err?'<div class="msg tc-err" style="margin:0 12px 10px">'+esc(CH.err)+'</div>':'')+pw+inp+'</div>'}
function grow(t){t.style.height="auto";t.style.height=Math.min(140,t.scrollHeight)+"px"}
function chatAfter(){var b=document.getElementById("cbody");if(!b)return;CH.seen=CH.seen||{};((S.ai||{}).messages||[]).forEach(function(m){CH.seen[ckey(m)]=1});var n=((S.ai||{}).messages||[]).length+((S.ai||{}).busy||CH.sending?1:0);if(n!==CH.n||CH.top===null){var ms=b.querySelectorAll(".tc-cm"),last=ms[ms.length-1];b.style.scrollBehavior="auto";b.scrollTop=last&&last.offsetHeight>b.clientHeight-16?last.offsetTop-8:b.scrollHeight;b.style.scrollBehavior=""}else b.scrollTop=CH.top;CH.n=n;b.onscroll=function(){CH.top=b.scrollTop};var t=document.getElementById("chin");if(t){grow(t);if(CH.refocus!==undefined&&CH.refocus!==null){t.focus();try{t.setSelectionRange(CH.refocus,CH.refocus)}catch(e){}CH.refocus=null}}}
function chatSend(text){var t=(text!==undefined?text:CH.draft).trim();if(!t||CH.sending)return;CH.sending=true;CH.err=null;if(text===undefined)CH.draft="";S.ai.messages=(S.ai.messages||[]).concat([{role:"you",text:t,ts:new Date().toISOString()}]);render();
api("/ai/chat",{text:t}).then(function(){return refresh()}).catch(function(e){CH.err=e.message;if(text===undefined)CH.draft=t}).then(function(){CH.sending=false;render()})}
function chatPw(){api("/ai/password",{password:CH.pw}).then(function(){CH.pw="";CH.err=null;return refresh()}).catch(function(e){CH.err=e.message;render()})}
function setCheckin(h){api("/ai/checkin",{hours:Number(h)}).then(function(){flash=[1,Number(h)?"Check-ins on. "+aiName()+" will review your rules and suggest changes for you to approve.":"Check-ins off."];refresh()}).catch(function(e){flash=[0,e.message];render()})}
function newChat(){api("/ai/new",{}).then(function(){CH.n=-1;CH.top=null;refresh()}).catch(function(e){flash=[0,e.message];render()})}
function tokIcon(sym,chain){var k=String(sym||"").toUpperCase();if(k==="WETH")k="ETH";var svg=COIN.coin[k];return '<div class="ic tok">'+(svg||esc(k.slice(0,3)))+(chain&&COIN.chain[chain]?'<span class="cb">'+COIN.chain[chain]+'</span>':"")+'</div>'}
function chainIcon(chain,extra){return '<div class="ic tok">'+(COIN.chain[chain]||esc(String(chain||"?")[0].toUpperCase()))+(extra&&COIN.chain[extra]?'<span class="cb">'+COIN.chain[extra]+'</span>':"")+'</div>'}
function kindIcon(e){var m=/^[\d.,]+ ([A-Za-z]+)/.exec(e.detail||"");if(e.kind!=="payment"&&m)return tokIcon(m[1],e.chain);return '<div class="ic tok"><span class="glyph">'+(e.kind==="payment"?"P":e.kind==="trade"?"S":"W")+'</span>'+(COIN.chain[e.chain]?'<span class="cb">'+COIN.chain[e.chain]+'</span>':"")+'</div>'}
function amt(x){var n=Number(x);return isFinite(n)?n.toLocaleString(undefined,{maximumFractionDigits:6}):String(x)}
var NAMES={ETH:"Ethereum",WETH:"Wrapped Ether",USDC:"USD Coin",USDT:"Tether",SOL:"Solana"},CHAIN_NAMES={base:"Base",ethereum:"Ethereum",solana:"Solana"},prevVal={};
function priceOf(sym){var p=S&&S.prices&&S.prices.prices;return p&&p[String(sym).toUpperCase()]||null}
function fmtUsd(n){if(n>0&&n<0.01)return "<$0.01";return "$"+n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
function fmtAmt(a){if(!a)return "0";return a.toLocaleString(undefined,a<1?{minimumFractionDigits:2,maximumFractionDigits:7}:{maximumFractionDigits:4})}
var PV=null,TEMPL=["Buy $25 of SOL every Monday","Buy $50 of ETH if it drops 5%","Sell half my ETH if it rises 10% and sell all ETH if it falls 8%","Trailing stop 10% on SOL"];
function stLabel(s){return {proposed:"Waiting for you",active:"On",paused:"Paused",done:"Done",cancelled:"Cancelled",expired:"Expired",error:"Stopped"}[s]||s}
function away(r){var p=r.state&&r.state.last_price;if(!p)return "";var t=r.kind==="trailing_stop"&&r.state.high?r.state.high*(1-r.trail_pct/100):r.trigger_price;if(!t)return " · now "+fmtUsd(p);var d=(p-t)/p*100;return " · now "+fmtUsd(p)+", trigger "+fmtUsd(t)+" ("+Math.abs(d).toFixed(1)+"% "+(d>0?"above":"below")+")"}
function ruleCard(r){var fills=(r.state&&r.state.fills||[]).filter(function(f){return f.ok});var last=fills[fills.length-1];var btn=function(id,st,lbl,cls){return '<button class="b '+cls+'" style="padding:7px 11px;font-size:12px" onclick="setRule(\''+id+'\',\''+st+'\')">'+lbl+'</button>'};
var acts=r.status==="proposed"?btn(r.id,"active","Turn on","ok")+btn(r.id,"cancelled","Dismiss","no"):r.status==="active"?btn(r.id,"paused","Pause","g")+btn(r.id,"cancelled","Cancel","no"):(r.status==="paused"||r.status==="error")?btn(r.id,"active","Turn on","ok")+btn(r.id,"cancelled","Cancel","no"):"";
return '<div class="row rule-'+r.status+'" style="display:block"><div style="display:flex;gap:10px;align-items:center">'+tokIcon(r.token,r.chain)+'<div style="min-width:0"><div>'+esc(r.description)+'</div><div class="sm mut">'+esc(stLabel(r.status))+(r.created_by==="agent"?" · suggested by AI":"")+(r.group&&(S.rules||[]).filter(function(x){return x.group===r.group&&x.id!==r.id}).length?" · linked: when one fills, the other cancels":"")+(r.status==="active"?esc(away(r)):"")+(fills.length?" · "+fills.length+" fill"+(fills.length>1?"s":""):"")+(last&&last.tx&&EXP[r.chain]&&!last.paper?' · <a target="_blank" rel="noopener" href="'+EXP[r.chain]+esc(last.tx)+'">last tx</a>':"")+'</div>'+(r.state&&r.state.last_error&&r.status!=="done"?'<div class="sm warn">'+esc(r.state.last_error)+'</div>':"")+(r.reason?'<div class="tc-why">'+esc(r.reason)+'</div>':"")+(r.replaces?'<div class="sm mut">Replaces: '+esc(((S.rules||[]).filter(function(x){return x.id===r.replaces})[0]||{description:r.replaces}).description)+'</div>':"")+(r.state&&r.state.note?'<div class="sm mut">'+esc(r.state.note)+'</div>':"")+'</div></div>'+(acts?'<div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end">'+acts+'</div>':"")+'</div>'}
function autopilot(){var R=S.rules||[],A=S.autopilot||{};var st=A.here?'<span class="ok">● Autopilot on</span> · checks prices every 15s':A.running?'<span class="ok">● Autopilot on</span> in another window ('+esc(A.mode||"live")+')':'<span class="warn">● Autopilot not running</span>';
var inChat={};((S.ai||{}).messages||[]).forEach(function(m){(m.rules||[]).forEach(function(id){inChat[id]=1})});
var prop=R.filter(function(r){return r.status==="proposed"&&!inChat[r.id]}),act=R.filter(function(r){return r.status==="active"||r.status==="paused"||r.status==="error"}),hist=R.filter(function(r){return ["done","cancelled","expired"].indexOf(r.status)>=0}).slice(0,15);
var pv=PV?'<div class="ap" style="margin-top:10px"><div class="sm mut" style="margin-bottom:6px">Preview: nothing runs until you turn it on</div>'+(PV.rules.length?PV.rules.map(function(r){return '<div style="margin:4px 0">• '+esc(r.description)+(r.problem?' <span class="bad sm">('+esc(r.problem)+')</span>':"")+'</div>'}).join(""):'<div class="bad">No rules understood.</div>')+(PV.unparsed.length?'<div class="sm warn" style="margin-top:6px">Not understood: '+esc(PV.unparsed.join(" · "))+'</div>':"")+'<div class="btns"><button class="b g" onclick="PV=null;render()">Discard</button><button class="b ok"'+(PV.rules.length&&!PV.rules.some(function(r){return r.problem})?"":" disabled")+' onclick="addRules()">Turn on</button></div></div>':"";
var manualOpen=CH.manual||!S.ai||!(S.ai||{}).provider;
return '<div class="sm">'+st+'</div><div class="sm mut" style="margin-top:3px">Every fill follows your limits and approvals, with the same 0.5% fee as any swap.</div>'+msg()+
chatBox()+
(prop.length?'<h3>Waiting for you</h3>'+prop.map(ruleCard).join(""):"")+
'<h3>Your rules</h3>'+(act.length?act.map(ruleCard).join(""):'<div class="mut sm">No rules on yet.</div>')+
(hist.length?'<h3>History</h3>'+hist.map(ruleCard).join(""):"")+
'<details class="mrule"'+(manualOpen?" open":"")+' ontoggle="CH.manual=this.open"><summary>Write a rule yourself</summary><textarea id="stxt" rows="3" placeholder="e.g. Buy $25 of SOL every Monday. Sell half my ETH if it rises 10% and all if it falls 8%." style="width:100%;margin-top:8px;background:var(--surf);border:1px solid var(--line);color:var(--tx);border-radius:10px;padding:10px;font:inherit;resize:vertical"></textarea>'+
'<div class="toggles" style="margin-top:6px">'+TEMPL.map(function(t,i){return '<button class="chip" style="border:0;cursor:pointer" onclick="document.getElementById(\'stxt\').value=TEMPL['+i+']">'+esc(t)+'</button>'}).join("")+'</div>'+
'<div style="margin-top:10px"><button class="b" onclick="preview()">Preview</button></div>'+pv+'</details>'}
function preview(){var t=document.getElementById("stxt").value;api("/rules/preview",{text:t}).then(function(r){PV=r;flash=null;render()}).catch(function(e){flash=[0,e.message];render()})}
function addRules(){var rules=PV.rules.map(function(r){var o={};for(var k in r)if(k!=="description"&&k!=="problem")o[k]=r[k];return o});api("/rules",{rules:rules}).then(function(){PV=null;flash=[1,"Turned on. The autopilot is watching prices."];refresh()}).catch(function(e){flash=[0,e.message];render()})}
function setRule(id,st){api("/rules/status",{id:id,status:st}).then(function(){flash=[1,st==="active"?"Turned on.":st==="paused"?"Paused.":"Cancelled."];refresh()}).catch(function(e){flash=[0,e.message];render()})}
function liveFor(tx){if(!tx||!S||!S.live)return null;for(var i=0;i<S.live.events.length;i++)if(S.live.events[i].tx===tx)return S.live.events[i];return null}
function lag(c){var h=S&&S.live&&S.live.heads&&S.live.heads[c];return h&&h.head&&h.finalized?Math.max(1,h.head-h.finalized):null}
function confText(e){if(e.status==="failed")return "Failed";if(e.status==="final")return e.chain==="solana"?"Finalized":"Final";if(e.status==="pending")return "Waiting to confirm";if(e.chain==="solana")return "Confirmed";return "Confirmed · "+(e.confirmations||0).toLocaleString()+" block"+(e.confirmations===1?"":"s")}
function confPct(e){if(e.status==="final")return 1;if(e.status==="failed"||e.status==="pending")return 0.04;if(e.chain==="solana")return 0.66;var l=lag(e.chain);return l?Math.min(0.97,Math.max(0.06,(e.confirmations||0)/l)):0.5}
function ring(e){var p=confPct(e),C=2*Math.PI*9,col=e.status==="failed"?"var(--bad)":e.status==="final"?"var(--ok)":"var(--acc)";return '<svg class="ring'+(e.status==="pending"||e.status==="confirmed"?" spin":"")+'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="var(--surf2)" stroke-width="3"/><circle cx="12" cy="12" r="9" fill="none" stroke="'+col+'" stroke-width="3" stroke-linecap="round" stroke-dasharray="'+(C*p).toFixed(1)+' '+C.toFixed(1)+'" transform="rotate(-90 12 12)" style="transition:stroke-dasharray 1s var(--ease)"/>'+(e.status==="final"?'<path d="M8 12.5l2.6 2.6L16 9.8" fill="none" stroke="var(--ok)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>':"")+'</svg>'}
function confChip(e){return e?' <span class="conf '+e.status+'">'+ring(e)+esc(confText(e))+'</span>':""}
function liveSection(){if(!S.live)return "";var day=Date.now()-86400000;var ev=S.live.events.filter(function(e){return Date.parse(e.first_seen)>day}).slice(0,5);if(!ev.length)return "";
return '<h3>Live <span class="livedot"></span></h3>'+ev.map(function(e){var title=e.direction==="in"?"Received "+esc(amt(e.amount))+" "+esc(e.token):esc(e.label||"Sent");var sub=e.direction==="in"?(e.from?"from "+esc(short(e.from)):"deposit"):esc(e.amount);
return '<div class="row live-'+e.status+'">'+(e.direction==="in"?tokIcon(e.token,e.chain):kindIcon({kind:e.label==="Swap"?"trade":"withdrawal",chain:e.chain,detail:e.amount}))+'<div style="min-width:0"><div>'+title+'</div><div class="sm mut" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">'+sub+' · '+ago(e.first_seen)+(e.tx&&EXP[e.chain]?' · <a target="_blank" rel="noopener" href="'+EXP[e.chain]+esc(e.tx)+'">tx</a>':"")+'</div></div><div class="r">'+confChip(e)+'</div></div>'}).join("")}
var seenLive=null;
function toast(html,kind){var h=document.getElementById("toasts");var t=document.createElement("div");t.className="toast "+(kind||"");t.innerHTML=html;h.appendChild(t);setTimeout(function(){t.classList.add("out");setTimeout(function(){t.remove()},600)},5200)}
function notifyLive(){if(!S||!S.live)return;var ids=S.live.events.map(function(e){return e.id});if(seenLive===null){seenLive={};ids.forEach(function(i){seenLive[i]=1});return}
S.live.events.forEach(function(e){if(seenLive[e.id])return;seenLive[e.id]=1;if(e.direction==="in")toast(tokIcon(e.token,e.chain)+'<div><b>Received '+esc(amt(e.amount))+' '+esc(e.token)+'</b><div class="sm mut">on '+esc(e.chain)+' · '+esc(confText(e))+'</div></div>',"in");else toast('<div><b>'+esc(e.label||"Sent")+' sent</b><div class="sm mut">'+esc(e.chain)+' · waiting for confirmations</div></div>',"out")})}
var CPI='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
function cpBtn(a){return '<button class="cp" title="Copy full address" onclick="cp(this,\''+esc(a)+'\')">'+CPI+'Copy</button>'}
function cp(btn,a){var done=function(){btn.classList.add("done");btn.innerHTML=CPI+"Copied";setTimeout(function(){btn.classList.remove("done");btn.innerHTML=CPI+"Copy"},1500)};
if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(a).then(done,function(){fallback(a);done()});else{fallback(a);done()}}
function fallback(a){var t=document.createElement("textarea");t.value=a;t.style.position="fixed";t.style.opacity="0";document.body.appendChild(t);t.select();try{document.execCommand("copy")}catch(e){}t.remove()}
function shortWhy(r){r=String(r);var m=/reverted: "([^"]+)"/.exec(r);if(m)r="Transaction would fail: "+m[1];r=r.split(" (action=")[0];return r.length>140?r.slice(0,137)+"…":r}
function rowUsd(e){if(Number(e.usd)>0)return usd(e.usd);var m=/^([\d.]+) ([A-Za-z]+)/.exec(e.detail||""),p=m&&priceOf(m[2]==="WETH"?"ETH":m[2]);return p&&p.usd?'<span title="at today\'s price">≈'+usd(Number(m[1])*p.usd)+'</span>':usd(e.usd)}
function usd(n){n=Number(n)||0;return "$"+n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:n<1&&n>0?4:2})}
function ago(ts){var s=(Date.now()-Date.parse(ts))/1000;if(s<60)return "just now";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return new Date(ts).toLocaleDateString()}
var ICONS={autopilot:'<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',home:'<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',activity:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',approvals:'<path d="M5 13l4 4L19 7"/>',limits:'<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/>',withdraw:'<path d="M12 4v12m0 0l-5-5m5 5l5-5M5 20h14"/>'};
var TABS=["home","activity","autopilot","approvals","limits","withdraw"],lastBadge=-1,lastAuto=-1;
function nav(){var el=document.getElementById("nav");if(!el.querySelector("button")){el.innerHTML='<div class="ind" id="ind"></div>'+TABS.map(function(k){return '<button data-k="'+k+'" onclick="go(\''+k+'\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+ICONS[k]+'</svg>'+k[0].toUpperCase()+k.slice(1)+'</button>'}).join("")}
el.querySelectorAll("button").forEach(function(b){b.classList.toggle("on",b.getAttribute("data-k")===tab)});
document.getElementById("ind").style.transform="translateX("+(TABS.indexOf(tab)*100)+"%)";
var na=S&&S.rules?S.rules.filter(function(r){return r.status==="proposed"}).length:0;if(na!==lastAuto){lastAuto=na;var aa=el.querySelector('[data-k="autopilot"]'),o2=aa.querySelector(".badge");if(o2)o2.remove();if(na){var s2=document.createElement("span");s2.className="badge";s2.textContent=na;aa.appendChild(s2)}}
var n=S?S.pending.length:0;if(n!==lastBadge){lastBadge=n;var ab=el.querySelector('[data-k="approvals"]'),old=ab.querySelector(".badge");if(old)old.remove();if(n){var sp=document.createElement("span");sp.className="badge";sp.textContent=n;ab.appendChild(sp)}}}
function go(k){if(k===tab&&!flash)return;tab=k;flash=null;render(true)}
function msg(){return flash?'<div class="msg '+(flash[0]?"okk":"err")+'">'+esc(flash[1])+'</div>':""}
function render(enter){nav();if(!S)return;var a=S.approvals||"none";var ap=document.getElementById("appr");ap.classList.toggle("live",a!=="none"||!!S.live);ap.textContent=(S.live?"Live":"")+(S.live?" · ":"")+(a==="none"?"Approvals off":"Approvals on");ap.title=a==="none"?"Set up Telegram or keep this page open":"Answered via "+a.replace("+"," and ");var m=document.getElementById("main");
if(tab!=="autopilot")LASTAP=null;var prevTab=m.dataset.tab;m.dataset.tab=tab;if(tab==="home")m.innerHTML=home();else if(tab==="activity")m.innerHTML=activity();else if(tab==="approvals")m.innerHTML=approvals();else if(tab==="limits")m.innerHTML=limits();else if(tab==="autopilot"){var h=autopilot();if(!enter&&h===LASTAP&&prevTab==="autopilot"){chatAfter();return}m.innerHTML=h;LASTAP=h;chatAfter()}else{m.innerHTML=withdraw();tokOpts()}
after(m,enter)}
var shown=null;
function after(m,enter){m.querySelectorAll(".row,.ap").forEach(function(r){r.classList.add("spot")});
if(!enter)m.classList.remove("enter");
if(enter&&!RM){m.classList.remove("enter");void m.offsetWidth;Array.prototype.forEach.call(m.children,function(c,i){c.style.setProperty("--i",Math.min(i,12))});m.classList.add("enter");setTimeout(function(){m.classList.remove("enter")},1400)}
var bars=m.querySelectorAll(".bar i[data-w]");if(enter&&!RM){requestAnimationFrame(function(){requestAnimationFrame(function(){bars.forEach(function(b){b.style.width=b.getAttribute("data-w")+"%"})})})}else bars.forEach(function(b){b.style.transition="none";b.style.width=b.getAttribute("data-w")+"%"});
var t=document.getElementById("tot");if(t&&t.hasAttribute("data-v")){var to=Number(t.getAttribute("data-v"));if(RM){shown=to;t.textContent=fmtUsd(to)}else count(to)}}
// Count the balance up to its value. Survives re-renders: each frame writes to whatever #tot is on the page now.
var cnt=null;
function count(to){if(cnt&&cnt.to===to)return;var from=shown===null?0:shown;if(from===to&&!cnt){var el=document.getElementById("tot");if(el)el.textContent=fmtUsd(to);return}
cnt={from:from,to:to,t0:performance.now(),d:1400};var c=cnt;(function f(now){if(cnt!==c)return;var k=Math.min(1,(now-c.t0)/c.d),e=1-Math.pow(1-k,4);shown=c.from+(c.to-c.from)*(k===1?1:e);var el=document.getElementById("tot");if(el)el.textContent=fmtUsd(shown);if(k<1)requestAnimationFrame(f);else cnt=null})(c.t0)}
function home(){var tot=0,chg=0,hasUnpriced=false,rows="";var BL=(S.live&&S.live.balances&&Object.keys(S.live.balances).length)?S.live.balances:B;if(BL){Object.keys(BL).forEach(function(c){var v=BL[c];if(v.error){rows+='<div class="row">'+chainIcon(c)+'<div>'+c+'<div class="sm bad">'+esc(v.error)+'</div></div></div>';return}
v.forEach(function(t){var a=Number(t.amount),pr=priceOf(t.token),val=pr?a*pr.usd:null;if(val!==null){tot+=val;if(pr.change_24h!==null)chg+=val-val/(1+pr.change_24h)}else hasUnpriced=true;var key=c+":"+t.token,dir=val!==null&&prevVal[key]!==undefined&&Math.abs(val-prevVal[key])>1e-9?(val>prevVal[key]?" up":" down"):"";if(val!==null)prevVal[key]=val;
rows+='<div class="row">'+tokIcon(t.token,c)+'<div style="min-width:0"><div class="tname">'+esc(NAMES[t.token]||t.token)+'</div><div class="sm">'+(pr&&pr.change_24h!==null&&!/^USD/.test(t.token)?'<span class="'+(pr.change_24h>=0?"ok":"bad")+'">'+(pr.change_24h>=0?"+":"")+(pr.change_24h*100).toFixed(2)+'%</span><span class="mut"> · '+esc(CHAIN_NAMES[c]||c)+'</span>':'<span class="mut">'+esc(CHAIN_NAMES[c]||c)+'</span>')+'</div></div><div class="r"><div class="usdv'+dir+'">'+(val===null?"—":fmtUsd(val))+'</div><div class="sm mut">'+esc(fmtAmt(a))+' '+esc(t.token)+'</div></div></div>'})})}
var p=S.policy,sp=S.spent_today;function lim(lbl,used,max){return '<div class="row" style="display:block"><div style="display:flex"><span>'+lbl+'</span><span class="r mut">'+usd(used)+' of '+usd(max)+'</span></div><div class="bar"><i data-w="'+Math.min(100,used/max*100).toFixed(2)+'"></i></div></div>'}
var chgPct=tot-chg>0?chg/(tot-chg):0;
return '<div class="mut sm">Total balance</div><div class="big">'+(BL?'<span id="tot" data-v="'+tot+'">'+fmtUsd(shown===null?0:shown)+'</span>':'<span class="skel"></span>')+'</div><div class="sm daychg">'+(BL&&S.prices&&S.prices.at?'<span class="'+(chg>=0?"ok":"bad")+'">'+(Math.abs(chg)<0.01?(chg>=0?"+":"−")+"$0.00":(chg>=0?"+":"−")+fmtUsd(Math.abs(chg)))+' ('+(chg>=0?"+":"")+(chgPct*100).toFixed(2)+'%)</span><span class="mut"> today</span>':'<span class="mut">Prices loading…</span>')+'</div>'+
aiBtn()+liveSection()+'<h3>Today</h3>'+lim("Trades",sp.trades_usd,p.daily_trades_usd)+lim("Payments",sp.payments_usd,p.daily_payments_usd)+
'<h3>Balances</h3>'+(rows||'<div class="mut">Loading…</div>')+
'<h3>Deposit addresses</h3><div class="row">'+chainIcon("base","ethereum")+'<div><div class="sm mut">Base / Ethereum</div><div class="addr" title="'+esc(S.addresses.evm)+'">'+esc(short(S.addresses.evm))+'</div></div>'+cpBtn(S.addresses.evm)+'</div><div class="row">'+chainIcon("solana")+'<div><div class="sm mut">Solana</div><div class="addr" title="'+esc(S.addresses.solana)+'">'+esc(short(S.addresses.solana))+'</div></div>'+cpBtn(S.addresses.solana)+'</div>'}
function activity(){var r=S.receipts;if(!r.length)return '<div class="empty">No trades or payments yet.</div>';return '<div style="display:flex;align-items:center"><h3 style="margin:0">Activity</h3><a class="sm" style="margin-left:auto" href="/api/receipts.csv?t='+T+'">Export CSV</a></div>'+r.map(function(e){var name=e.kind==="trade"?"Swap":e.kind==="payment"?"Payment":"Withdrawal";var st=e.status==="done"?"":(e.status==="failed"?' <span class="chip bad">failed</span>':' <span class="chip warn">pending</span>');var link=(e.tx&&EXP[e.chain]?' · <a target="_blank" rel="noopener" href="'+EXP[e.chain]+esc(e.tx)+'">tx</a>':"")+confChip(liveFor(e.tx));
return '<div class="row">'+kindIcon(e)+'<div style="min-width:0"><div>'+name+st+'</div><div class="sm mut" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px">'+esc(e.kind==="payment"?e.seller:(e.detail||""))+'</div><div class="sm mut">'+esc(e.chain||"")+' · '+ago(e.ts)+link+(e.reason?'<div class="sm bad" style="overflow-wrap:anywhere" title="'+esc(e.reason)+'">'+esc(shortWhy(e.reason))+'</div>':"")+'</div></div><div class="r">'+rowUsd(e)+(e.fee_usd?'<div class="sm mut">fee '+usd(e.fee_usd)+'</div>':"")+'</div></div>'}).join("")}
function approvals(){var p=S.pending;var head='<h3>Waiting for you</h3>';if(!p.length)return head+'<div class="empty">Nothing to approve.<div class="sm" style="margin-top:6px">Trades over '+usd(S.policy.approval_above_usd)+' show up here and in Telegram while this page is open.</div></div>'+msg();
return head+p.map(function(x){return '<div class="ap">'+esc(x.text)+'<div class="sm mut" style="margin-top:6px">Expires '+new Date(x.expires).toLocaleTimeString()+'</div><div class="btns"><button class="b no" onclick="ans(\''+x.id+'\',\'denied\')">Deny</button><button class="b ok" onclick="ans(\''+x.id+'\',\'approved\')">Approve</button></div></div>'}).join("")+msg()}
function ans(id,d){api("/approve",{id:id,decision:d}).then(function(){flash=[1,d==="approved"?"Approved.":"Denied."];refresh()}).catch(function(e){flash=[0,e.message];render()})}
var F=[["per_trade_usd","Per trade ($)"],["daily_trades_usd","Trades per day ($)"],["approval_above_usd","Ask me above ($)"],["max_slippage_bps","Max slippage (bps)"],["per_payment_usd","Per payment ($)"],["daily_payments_usd","Payments per day ($)"],["per_seller_daily_usd","Per seller per day ($)"]];
function limits(){var p=S.policy;return '<h3>Limits</h3><div class="mut sm">The agent can\'t change these. Saving needs your password.</div><div class="grid2">'+F.map(function(f){return '<div><label>'+f[1]+'</label><input id="f_'+f[0]+'" type="number" min="0" step="any" value="'+p[f[0]]+'"></div>'}).join("")+'</div>'+
'<label>Chains</label><div class="toggles">'+["base","solana","ethereum"].map(function(c){return '<label><input type="checkbox" id="c_'+c+'"'+(p.chains.indexOf(c)>=0?" checked":"")+'> '+c+'</label>'}).join("")+'</div>'+
'<div class="toggles" style="margin-top:8px"><label><input type="checkbox" id="f_bsw"'+(p.block_seller_warnings?" checked":"")+'> Block sellers that fail the seller check</label></div>'+
'<div class="toggles" style="margin-top:8px"><label><input type="checkbox" id="f_ar"'+(p.agent_rules==="auto"?" checked":"")+'> Let agents turn on autopilot rules without asking me</label></div>'+
'<label>Password</label><input id="pw1" type="password" autocomplete="current-password"><div style="margin-top:12px"><button class="b" onclick="saveLim()">Save limits</button></div>'+msg()}
function saveLim(){var p={};F.forEach(function(f){p[f[0]]=Number(document.getElementById("f_"+f[0]).value)});p.max_slippage_bps=Math.round(p.max_slippage_bps);p.chains=["base","solana","ethereum"].filter(function(c){return document.getElementById("c_"+c).checked});p.block_seller_warnings=document.getElementById("f_bsw").checked;p.agent_rules=document.getElementById("f_ar").checked?"auto":"propose";
api("/policy",{password:document.getElementById("pw1").value,policy:p}).then(function(){flash=[1,"Saved."];refresh()}).catch(function(e){flash=[0,e.message];render()})}
var conf=null;
function withdraw(){var W=S.policy.withdraw_addresses;var saved=W.length?W.map(function(a){return '<div class="row">'+chainIcon(a.chain)+'<div style="min-width:0"><div>'+esc(a.label||a.chain)+'</div><div class="addr mut" title="'+esc(a.address)+'">'+esc(short(a.address))+'</div></div><div class="r" style="display:flex;gap:6px">'+cpBtn(a.address)+'<button class="b no" style="padding:6px 9px;font-size:12px" onclick="rmAddr(\''+a.chain+'\',\''+esc(a.address)+'\')">Remove</button></div></div>'}).join(""):'<div class="mut sm">None yet. Funds can only be withdrawn to an address saved here.</div>';
var opts=W.map(function(a,i){return '<option value="'+i+'">'+esc((a.label?a.label+" · ":"")+a.chain+" · "+a.address.slice(0,6)+"…"+a.address.slice(-4))+'</option>'}).join("");
var form=W.length?'<h3>Withdraw</h3><label>To</label><select id="w_to" onchange="tokOpts()">'+opts+'</select><div class="grid2"><div><label>Token</label><select id="w_tok"></select></div><div><label>Amount</label><input id="w_amt" inputmode="decimal" placeholder="0.00"></div></div><label>Password</label><input id="pw2" type="password" autocomplete="current-password">'+
(conf?'<div class="ap" style="border-color:var(--warn)">Send '+esc(conf.amount)+' '+esc(conf.token)+' on '+esc(conf.chain)+' to '+esc(conf.to)+'? This can\'t be undone.<div class="btns"><button class="b g" onclick="conf=null;render()">Cancel</button><button class="b" onclick="doW()">Send</button></div></div>':'<div style="margin-top:12px"><button class="b" onclick="prepW()">Review</button></div>'):"";
return '<h3>Saved addresses</h3>'+saved+'<details style="margin-top:10px"><summary class="sm" style="cursor:pointer;color:var(--acc)">Add an address</summary><label>Chain</label><select id="a_ch"><option>base</option><option>solana</option><option>ethereum</option></select><label>Address</label><input id="a_ad" spellcheck="false"><label>Label</label><input id="a_lb" maxlength="40" placeholder="e.g. my Coinbase"><label>Password</label><input id="pw3" type="password" autocomplete="current-password"><div style="margin-top:12px"><button class="b g" onclick="addAddr()">Save address</button></div></details>'+form+msg()}
function tokOpts(){var s=document.getElementById("w_to");if(!s)return;var a=S.policy.withdraw_addresses[Number(s.value)];document.getElementById("w_tok").innerHTML=TOK[a.chain].map(function(t){return "<option>"+t+"</option>"}).join("")}
function addAddr(){api("/addresses",{password:document.getElementById("pw3").value,chain:document.getElementById("a_ch").value,address:document.getElementById("a_ad").value.trim(),label:document.getElementById("a_lb").value}).then(function(){flash=[1,"Address saved."];refresh()}).catch(function(e){flash=[0,e.message];render()})}
function rmAddr(c,a){var pw=prompt("Password to remove this address:");if(!pw)return;api("/addresses",{password:pw,action:"remove",chain:c,address:a}).then(function(){flash=[1,"Removed."];refresh()}).catch(function(e){flash=[0,e.message];render()})}
function prepW(){var a=S.policy.withdraw_addresses[Number(document.getElementById("w_to").value)];conf={chain:a.chain,to:a.address,token:document.getElementById("w_tok").value,amount:document.getElementById("w_amt").value.trim(),pw:document.getElementById("pw2").value};if(!conf.amount||!conf.pw){flash=[0,"Enter an amount and your password."];conf=null}render();if(conf){var s=document.getElementById("w_to");s.value=String(S.policy.withdraw_addresses.indexOf(a));tokOpts();document.getElementById("w_tok").value=conf.token;document.getElementById("w_amt").value=conf.amount;document.getElementById("pw2").value=conf.pw}}
function doW(){var c=conf;conf=null;flash=[1,"Sending…"];render();api("/withdraw",{password:c.pw,chain:c.chain,token:c.token,to:c.to,amount:c.amount}).then(function(r){flash=r.ok?[1,"Sent. Transaction "+r.tx]:[0,r.refused.reason];refresh();loadBal()}).catch(function(e){flash=[0,e.message];render()})}
function busy(){var el=document.activeElement;if(el&&el.id==="chin"){CH.refocus=el.selectionStart;return !!conf}return el&&(el.tagName==="INPUT"||el.tagName==="SELECT"||el.tagName==="TEXTAREA")||conf}
var lastS="";
function refresh(){return api("/state").then(function(s){var j=JSON.stringify(s);var first=!S;S=s;if(j===lastS)return;lastS=j;notifyLive();if(!busy())render(first);else nav()}).catch(function(e){document.getElementById("main").innerHTML='<div class="empty bad">'+esc(e.message)+'<div class="sm mut">Is <code>tollkit-wallet ui</code> still running?</div></div>'})}
function loadBal(){B=null;if(tab==="home")render();api("/balances").then(function(b){B=b;if(tab==="home"&&!busy())render()})}
// Spotlight follows the pointer inside rows and cards; the aurora leans toward it.
if(!RM&&matchMedia("(pointer: fine)").matches){document.addEventListener("pointermove",function(ev){var el=ev.target.closest&&ev.target.closest(".spot");if(el){var r=el.getBoundingClientRect();el.style.setProperty("--mx",(ev.clientX-r.left)+"px");el.style.setProperty("--my",(ev.clientY-r.top)+"px")}},{passive:true});
var dr=document.querySelector(".aur .drift"),px=0,py=0,raf=0;addEventListener("pointermove",function(ev){px=ev.clientX/innerWidth-.5;py=ev.clientY/innerHeight-.5;if(!raf)raf=requestAnimationFrame(function(){raf=0;dr.style.transform="translate("+(px*30)+"px,"+(py*22)+"px)"})},{passive:true})}
// First paint waits briefly for balances so the page arrives once, complete.
var firstBal=api("/balances").then(function(b){B=b}).catch(function(){});
Promise.all([api("/state").then(function(s){S=s;lastS=JSON.stringify(s);notifyLive()}),Promise.race([firstBal,new Promise(function(r){setTimeout(r,2500)})])]).then(function(){var had=!!B;render(true);if(!had)firstBal.then(function(){if(B&&tab==="home"&&!busy())render()})}).catch(function(e){document.getElementById("main").innerHTML='<div class="empty bad">'+esc(e.message)+'</div>'});
setInterval(refresh,2000);
</script></body></html>`;
