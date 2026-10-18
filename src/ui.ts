/** The dashboard page. One file, no outside scripts, fonts or images. */
import { COIN_ICONS } from "./coin-icons.js";
import { AI_ICONS } from "./ai-icons.js";
const COIN_JSON = JSON.stringify(COIN_ICONS).replace(/</g, "\\u003c");
const AI_ICON_JSON = JSON.stringify(AI_ICONS).replace(/</g, "\\u003c");
export const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tollkit</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='20' fill='%230a0a0a'/%3E%3Ctext x='50' y='68' font-family='ui-monospace,SFMono-Regular,monospace' font-size='56' font-weight='700' fill='%234a8eff' text-anchor='middle'%3Et%3C/text%3E%3C/svg%3E">
<style>
:root{--bg:#0d0e12;--card:#16171d;--surf:#1e2027;--surf2:#262934;--line:#2c2f3a;--tx:#f1f2f6;--mut:#979aab;--acc:#4a8eff;--acc2:#3a7bea;--ok:#3ccf91;--bad:#ff6b6b;--warn:#f5b84a}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]){--bg:#eceef3;--card:#fff;--surf:#f4f5f8;--surf2:#e9ebf1;--line:#e1e3ea;--tx:#15161b;--mut:#666a7a}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif}
.wrap{max-width:420px;margin:24px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;height:calc(100vh - 96px);height:calc(100dvh - 96px);min-height:520px;max-height:900px}
header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}
.logo{width:30px;height:30px;flex:none;display:block}
.brand{font:700 15px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.01em;white-space:nowrap}.brand .dot{color:#4a8eff}.brand .sub{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-weight:500;color:var(--mut);margin-left:6px}
.cp{margin-left:auto;flex:none;border:0;background:var(--surf2);color:var(--tx);border-radius:9px;padding:6px 10px;font:600 12px inherit;cursor:pointer;display:flex;align-items:center;gap:5px}
.cp svg{width:14px;height:14px}.cp.done{color:var(--ok)}header .pill{margin-left:auto;white-space:nowrap;font-size:11px;padding:4px 9px;border-radius:99px;background:var(--surf);color:var(--mut)}
main{flex:1;min-height:0;padding:16px;overflow:auto;overscroll-behavior:contain}
nav{flex:none;display:grid;grid-template-columns:repeat(6,1fr);border-top:1px solid var(--line);background:var(--card)}
nav button{background:none;border:0;color:var(--mut);padding:10px 0 12px;font:inherit;font-size:11px;cursor:pointer;position:relative}
nav button svg{display:block;margin:0 auto 3px;width:20px;height:20px}
nav button.on{color:var(--acc)}
.badge{position:absolute;top:5px;left:calc(50% + 6px);background:var(--bad);color:#fff;border-radius:99px;font-size:10px;padding:0 5px;min-width:16px}
.badge.dot{min-width:0;width:8px;height:8px;padding:0;top:7px;left:calc(50% + 8px)}
nav button.attn{--hi:var(--acc)}nav button.attn-bad{--hi:var(--bad)}nav button.attn-warn{--hi:var(--warn)}nav button.attn-ok{--hi:var(--ok)}
nav button.attn:not(.on){color:var(--hi)}nav button.attn .badge{background:var(--hi);color:#fff}nav button.attn-warn .badge{color:#1a1206}
nav button.attn:not(.on)::before{content:"";position:absolute;left:50%;top:6px;width:34px;height:34px;margin-left:-17px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--hi) 30%,transparent),transparent 70%);animation:navhi 2.4s ease-in-out infinite;pointer-events:none}
nav button.attn:not(.on) .emo{opacity:1;filter:none}
@keyframes navhi{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.1)}}
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
.ap{background:var(--surf);border:1px solid var(--acc);border-radius:14px;padding:12px;margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere}
.ap .btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.empty{text-align:center;color:var(--mut);padding:40px 10px}
a{color:var(--acc)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.toggles{display:flex;gap:6px;flex-wrap:wrap}.toggles label{display:flex;align-items:center;gap:6px;margin:0;padding:8px 10px;background:var(--surf);border-radius:10px;color:var(--tx);font-size:13px}
.toggles input{width:auto}
.sgrp{font-size:13px;font-weight:600;color:var(--tx);margin:16px 0 0}.sth{margin-top:4px}.stg{flex-direction:column;align-items:flex-start}.ssave{display:flex;align-items:center;gap:12px;margin-top:12px}button.b.sbtn{padding:8px 12px;font-size:13px;white-space:nowrap}

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
.tmico{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:12px;flex:none}.tmico svg{width:21px;height:21px}.tmico.sm{width:32px;height:32px;border-radius:10px}.tmico.sm svg{width:18px;height:18px}
.tmai{background:color-mix(in srgb,#d97757 18%,transparent);color:#d97757}.tmpy{background:color-mix(in srgb,var(--acc) 16%,transparent);color:var(--acc)}
.pycard{background:var(--surf);border:1px solid color-mix(in srgb,var(--acc) 40%,var(--line));border-radius:14px;padding:12px;margin:12px 0 4px}.pyct{display:flex;align-items:center;gap:10px}.pyct>div{flex:1}
.pystep{display:flex;align-items:center;gap:8px;margin:16px 0 4px}.pystep b{font-size:14px}.pyn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:color-mix(in srgb,var(--acc) 18%,transparent);color:var(--acc);font-size:12px;font-weight:700}
.pymore{margin:2px 0 6px}.pymore summary{cursor:pointer;font-size:12.5px;color:var(--mut)}.pymore summary:hover{color:var(--tx)}
.aiacts{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;padding-left:35px}.aiacts .aihand{padding:4px 0 0}.aicopen{margin-top:6px}.aiok{border-color:color-mix(in srgb,var(--ok) 45%,transparent)}
.tc-fuel{margin-top:8px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}.tc-fuel .b{padding:8px 12px;font-size:13px}.tc-fchk{display:flex;gap:7px;align-items:center;font-size:12.5px;cursor:pointer}.tc-fchk input{margin:0}.tc-own{margin:6px 0 0;font-size:12px}.tmseg{margin:0}.tmseg .bsb{padding:5px 12px}
.aicmd{display:flex;gap:8px;align-items:flex-start;background:#08090c;border:1px solid var(--line);border-radius:12px;padding:9px 9px 9px 13px;margin:8px 0}
.aicmd pre{flex:1;min-width:0;margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cdd6e4;white-space:pre-wrap;overflow-wrap:anywhere}
.aicp{padding:6px 11px;font-size:12.5px;border-radius:9px}
.aigoap{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:14px;background:linear-gradient(135deg,var(--acc),var(--acc2))}.aigoap svg{margin:0}
.aidone{margin-top:16px;padding-top:13px;border-top:1px solid var(--line);font-size:13px;color:var(--mut);line-height:1.5}.aidone b{color:var(--tx)}
@keyframes aifade{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.aio,.aidlg,.airow{animation:none}}
.tc-chat{background:var(--surf);border:1px solid var(--line);border-radius:18px;margin-top:12px;overflow:hidden}
.tc-chd{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 10px;padding:11px 12px;border-bottom:1px solid var(--line)}
.tc-chn{display:flex;align-items:center;gap:9px;min-width:0}.tc-chn>svg{width:22px;height:22px;flex:none;color:#d97757}.tc-chn b{display:block;font-size:14px}.tc-chn small{display:block;font-size:11.5px;color:var(--mut)}
.tc-chr{display:flex;align-items:center;gap:6px;margin-left:auto}.tc-chk{display:flex;align-items:center;gap:4px;color:var(--mut)}
.tc-chk select{background:var(--surf2);color:var(--tx);border:1px solid var(--line);border-radius:9px;padding:5px 6px;font:inherit;font-size:12px}
.tc-chx{height:32px;padding:0 10px;border-radius:9px;display:flex;align-items:center;gap:5px;flex:none;font-size:12px;white-space:nowrap}.tc-chx svg{display:inline-block;width:14px;height:14px;margin:0}.b.tc-chx.tc-warn{background:rgba(245,184,74,.18);color:var(--warn)}.tc-csend svg{margin:0}
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
.bkb{display:flex;align-items:center;gap:11px;margin-top:14px;padding:11px 12px;border-radius:14px;background:rgba(245,184,74,.1);border:1px solid rgba(245,184,74,.45)}
.bki{color:var(--warn);flex:none;display:flex}.bki svg{margin:0}
.bkt{flex:1;min-width:0;display:flex;flex-direction:column}.bkt b{font-size:14px}.bkt small{font-size:12px;color:var(--mut);line-height:1.4}
.bkgo{flex:none;padding:8px 14px;border-radius:10px;font-size:13px}
.bkl{text-align:center;margin-top:14px}
.bkgrid{position:relative;display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:4px 0 6px}
.bkgrid div{background:var(--surf);border:1px solid var(--line);border-radius:10px;padding:9px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px}
.bkgrid div span{display:inline-block;min-width:22px;color:var(--mut);font-size:11px}
.bkgrid.bkblur div{filter:blur(7px);user-select:none}pre.bkblur{filter:blur(6px);user-select:none}
.bkreveal{position:absolute;inset:0;margin:auto;width:150px;height:42px;border-radius:21px;border:1px solid var(--line);background:var(--card);color:var(--tx);font:inherit;font-weight:600;cursor:pointer;filter:none}
.bkkey{margin-top:10px}.bkkey small{color:var(--mut);font-size:12px}
.bkchk{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:13.5px;justify-content:flex-start}.bkchk input{width:18px;height:18px;flex:none;margin:0}
.bkq{margin:12px 0}.bkq b{font-size:13px;color:var(--mut)}
.bkopts{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:6px}
.bkopt{padding:9px 4px;border-radius:10px;border:1px solid var(--line);background:var(--surf);color:var(--tx);font:inherit;font-size:13px;cursor:pointer}
.bkopt.ok{border-color:var(--ok);color:var(--ok)}.bkopt.bad{border-color:var(--bad);color:var(--bad)}
.bkdone{text-align:center}.bkdone>svg{width:44px;height:44px;color:var(--ok);margin:6px auto 4px;display:block}
@media (max-width:480px){.bkopts{grid-template-columns:repeat(2,1fr)}}
.tl{width:100%;height:100%;border-radius:50%;background:var(--surf2);display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;color:var(--mut);letter-spacing:-.02em}
.rowc{cursor:pointer}.rowc:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.hfoot{margin-top:8px;font-size:12px;color:var(--mut);text-align:center}
.botc{background:var(--surf);border:1px solid var(--line);border-radius:14px;padding:12px;margin-top:8px}.botct{display:flex;align-items:flex-start;gap:8px;justify-content:space-between}.botpill{white-space:nowrap}.botpill.ok{background:rgba(60,207,145,.15);color:var(--ok)}.botpill.warn{background:rgba(245,184,74,.15);color:var(--warn)}.botpill.bad{background:rgba(255,107,107,.15);color:var(--bad)}
.botstats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px}.botstats div{background:var(--card);border-radius:10px;padding:6px 8px;min-width:0}.botstats small{display:block;color:var(--mut);font-size:11px}.botstats b{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.botcat{display:grid;grid-template-columns:1fr 1fr;grid-auto-flow:row dense;gap:8px}.botlim{font-style:normal;color:var(--mut);opacity:.75;font-size:11px;margin-left:4px;white-space:nowrap}.botf input.botcap{animation:botcap .5s ease}@keyframes botcap{0%,100%{border-color:var(--line)}30%{border-color:var(--acc);box-shadow:0 0 0 3px rgba(var(--glow),.25)}}.botwrap{grid-column:1/-1;display:grid;grid-template-rows:1fr}.botin{min-height:0}.botin>.botform{margin:0}.botwrap.drop{animation:botopen .42s var(--ease) both}.botwrap.drop .botform{animation:botslide .42s var(--ease) both}.botwrap.closing{animation:botshut .24s ease-in both}.botwrap.drop .botin,.botwrap.closing .botin{overflow:hidden}
@keyframes botopen{from{grid-template-rows:0fr}to{grid-template-rows:1fr}}@keyframes botslide{from{opacity:0;transform:translateY(-14px) scale(.98)}to{opacity:1;transform:none}}@keyframes botshut{from{grid-template-rows:1fr;opacity:1}to{grid-template-rows:0fr;opacity:0}}
nav button .emo{display:block;margin:0 auto 3px;width:20px;height:20px;font-size:17px;line-height:20px;text-align:center;opacity:.75;filter:grayscale(.35);transition:transform .45s var(--ease),opacity .3s,filter .3s}nav button.on .emo{opacity:1;filter:none;transform:translateY(-2px) scale(1.1)}.bottpl{text-align:left;background:var(--surf);border:1px solid var(--line);border-radius:12px;padding:10px;color:var(--tx);font:inherit;cursor:pointer;display:flex;flex-direction:column;gap:4px}.bottpl small{color:var(--mut);font-size:12px;line-height:1.35}.bottpl.on,.bottpl:hover{border-color:var(--acc)}
.tplh{display:flex;align-items:flex-start;justify-content:space-between;gap:6px}.tplh b{min-width:0}
.botcta{margin-top:auto;align-self:flex-start;display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:99px;border:0;background:color-mix(in srgb,var(--acc) 15%,transparent);color:var(--acc);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:background .2s ease}
.botcta svg{transition:transform .25s var(--ease)}.bottpl:hover .botcta,.botcta:hover{background:color-mix(in srgb,var(--acc) 24%,transparent)}.bottpl:hover .botcta svg,.botcta:hover svg{transform:translateX(3px)}
.botcta.g{background:transparent;color:var(--mut);padding-left:6px;padding-right:6px}.botcta.g:hover{background:var(--surf2);color:var(--tx)}
.bottpl>.botcta{margin-top:auto;padding-top:6px}.bottpl>.boardl{margin-bottom:6px}
.bottpl.has{cursor:default;border-color:color-mix(in srgb,var(--ok) 45%,var(--line))}.bottpl.has.err{border-color:color-mix(in srgb,var(--bad) 55%,var(--line))}.bottpl.has.on{border-color:var(--acc)}
.tplbtns{display:flex;flex-wrap:wrap;gap:4px;margin-top:auto;padding-top:6px}.tplbtns .botcta{margin-top:0}
.botc.botflash{animation:botflash 1.6s ease}@keyframes botflash{0%,60%{border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 30%,transparent)}100%{border-color:var(--line);box-shadow:none}}
.botgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.botf{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mut)}.botf input,.botf select{background:var(--card);border:1px solid var(--line);color:var(--tx);border-radius:10px;padding:8px;font:inherit;font-size:13px;min-width:0}
.botshare{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--mut);margin-top:14px;line-height:1.4}.botshare input{width:auto;flex:0 0 auto;margin:2px 0 0}.addt .crow2 select{flex:0 0 104px;width:104px}.addt .crow2 input{flex:1 1 auto;min-width:0;width:auto}@media(max-width:420px){.botcat,.botgrid{grid-template-columns:1fr}.botstats{grid-template-columns:1fr 1fr}}
.tlogo{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}.tbadge{font-size:10px;padding:1px 6px;vertical-align:1px;margin-left:4px}
.atlist{display:flex;flex-direction:column;gap:4px;margin-top:8px;max-height:320px;overflow-y:auto}.atrow{display:flex;align-items:center;gap:10px;text-align:left;background:var(--surf);border:1px solid var(--line);border-radius:12px;padding:8px 10px;color:var(--tx);font:inherit;cursor:pointer}.atrow:hover{border-color:var(--acc)}.atn{min-width:0;display:flex;flex-direction:column}.atn small{color:var(--mut);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atw{margin-top:10px;padding:10px;border-radius:10px;background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.35);color:var(--bad);font-size:13px}.atw ul,.atchk ul{margin:6px 0 0;padding-left:18px}.atw li{margin:3px 0;color:var(--tx)}.atwarn{border-color:rgba(255,107,107,.45)}
.crow2{display:flex;gap:6px;margin-top:8px}.crow2 select,.crow2 input{background:var(--card);border:1px solid var(--line);color:var(--tx);border-radius:10px;padding:8px;font:inherit;font-size:13px}.crow2 input{flex:1;min-width:0}.crow2 .b{padding:8px 14px}
.chdlg{max-width:560px}
.chh{display:flex;align-items:center;gap:10px}.chh h2{margin:0;font-size:18px}
.chhero{margin:14px 0 10px}.chp{font-size:30px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.chr{display:flex;gap:6px;margin:0 0 10px}
.chrb{flex:1;padding:7px 0;border-radius:9px;border:1px solid var(--line);background:var(--surf);color:var(--mut);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.chrb.on{background:var(--surf2);color:var(--tx);border-color:var(--acc)}
.chbox{background:var(--surf);border:1px solid var(--line);border-radius:14px;padding:8px 8px 6px}
.chsvg{display:block;width:100%;height:auto;touch-action:none;transition:opacity .2s}.chsvg.ld{opacity:.45}.chsvg:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:8px}
.chl{fill:none;stroke:var(--acc);stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
.chg{stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke;stroke-dasharray:2 4}
.chx{stroke:var(--mut);stroke-width:1;vector-effect:non-scaling-stroke}
.chd{fill:var(--acc);stroke:var(--surf);stroke-width:2;vector-effect:non-scaling-stroke}
.chax{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--mut);margin-top:4px;font-variant-numeric:tabular-nums}
.chft{display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:12px}
.chtbl{max-height:220px;overflow:auto;margin-top:8px;border:1px solid var(--line);border-radius:10px}.chtbl table{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}.chtbl th,.chtbl td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--line)}.chtbl td:last-child,.chtbl th:last-child{text-align:right}
.wact{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:8px;margin-top:14px}
.wtile{display:flex;flex-direction:column;align-items:center;gap:6px;padding:11px 0 9px;border-radius:14px;background:var(--surf);border:1px solid var(--line);color:var(--tx);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:border-color .2s,transform .2s var(--ease)}
.wtile:hover{border-color:var(--acc)}.wtile:active{transform:scale(.97)}
.wtile i{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff}
.wtile i svg{width:18px;height:18px;margin:0;display:block}
.stk{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--surf);border-radius:12px;margin-top:8px}
.stk .r{margin-left:auto;display:flex;align-items:center;gap:8px}
.stc{font-size:11px;padding:2px 8px;border-radius:99px;background:var(--surf2);color:var(--mut);white-space:nowrap}.stc.active{color:var(--ok)}.stc.ready{color:var(--acc)}
.mvamt{display:flex;align-items:center;gap:8px}.mvamt input{flex:1}
.mvq{margin-top:12px;padding:10px 12px;background:var(--surf);border-radius:12px}
.mvr{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:3px 0;color:var(--mut)}.mvr b{color:var(--tx)}.mvr.tot{border-top:1px solid var(--line);margin-top:4px;padding-top:7px;color:var(--tx)}
.stnote{font-size:12.5px;color:var(--mut);margin-top:10px;line-height:1.5}
.bseg{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 12px}
.bsb{display:flex;align-items:center;gap:7px;padding:7px 12px 7px 7px;border-radius:12px;border:1px solid var(--line);background:var(--surf);color:var(--tx);font:inherit;font-size:13.5px;font-weight:600;cursor:pointer}
.bsb .ic{width:24px;height:24px}.bsb .ic svg{width:24px;height:24px}.bsb .cb{width:11px;height:11px;right:-3px;bottom:-3px}
.bseg .bsb:not(:has(.ic)){padding:7px 14px}
.bsb.on{border-color:var(--acc);background:var(--surf2)}
.bcust{width:90px;background:var(--surf);border:1px solid var(--line);color:var(--tx);border-radius:12px;padding:7px 10px;font:inherit;font-size:13.5px}
</style></head><body>
<div class="aur" aria-hidden="true"><div class="drift"><i></i><i></i><i></i></div></div>
<div class="wrap"><div class="card">
<header><svg style="--i:0" class="logo" viewBox="0 0 100 100" aria-hidden="true"><rect x="1.5" y="1.5" width="97" height="97" rx="20" fill="#0a0a0a" stroke="#2f3442" stroke-width="3"/><text x="50" y="68" font-family="ui-monospace,SFMono-Regular,monospace" font-size="56" font-weight="700" fill="#4a8eff" text-anchor="middle">t</text></svg><span class="brand" style="--i:1">Toll<span class="dot">kit</span></span><span class="pill" style="--i:2" id="appr">…</span></header>
<div id="toasts" aria-live="polite"></div><main id="main"><div class="empty">Loading…</div></main>
<nav id="nav"></nav>
</div><p class="mut sm" style="text-align:center">Running on this computer only. Keys never leave it.</p></div>
<script>
var RM=matchMedia("(prefers-reduced-motion: reduce)").matches;if(!RM)document.documentElement.classList.add("m");
var T=new URLSearchParams(location.search).get("t");history.replaceState(null,"","/");
var S=null,B=null,tab="home",flash=null;
var EXP={base:"https://basescan.org/tx/",ethereum:"https://etherscan.io/tx/",arbitrum:"https://arbiscan.io/tx/",polygon:"https://polygonscan.com/tx/",solana:"https://solscan.io/tx/"};
var TOK={base:["USDC","ETH"],ethereum:["USDC","USDT","ETH"],arbitrum:["USDC","ETH"],polygon:["USDC","POL"],solana:["USDC","USDT","SOL"]};
var NATIVE={base:"ETH",ethereum:"ETH",arbitrum:"ETH",polygon:"POL",solana:"SOL"},ALLCH=["base","solana","ethereum","arbitrum","polygon"],EVMNAMES="Base, Ethereum, Arbitrum, Polygon";
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function api(p,body){return fetch("/api"+p,{method:body?"POST":"GET",headers:{"x-tw-token":T,"content-type":"application/json"},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j})})}
function short(a){a=String(a||"");return a.length>14?a.slice(0,a.indexOf("0x")===0?6:4)+"…"+a.slice(-4):a}
var COIN=${COIN_JSON};
var AIIC=${AI_ICON_JSON},AIO=null,AIPW="",AIMSG={},AIOPEN={},AIBUSY=null,AICOPIED=null;
function aiSvg(k){var i=AIIC[k];return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor"'+(i.rule?' fill-rule="'+i.rule+'"':'')+' d="'+i.d+'"/></svg>'}
var AIMETA={claude:["claude","Claude"],"claude-code":["claude","Claude Code"],cursor:["cursor","Cursor"],vscode:["copilot","VS Code"],codex:["terminal","Codex"],gemini:["gemini","Gemini CLI"]};
function aiBtn(){var on=((S.connect||{}).apps||[]).filter(function(a){return a.added}),rm=(S.connect||{}).remote;
if(rm&&rm.on)on=[{id:"claude"}];
if(!on.length)return '<button class="b aib" onclick="openAI()"><span class="aiic">'+aiSvg("claude")+aiSvg("cursor")+aiSvg("gemini")+'</span>Connect your AI</button>';
var icons=[],names=[];on.forEach(function(a){var m=AIMETA[a.id];if(!m)return;names.push(m[1]);if(icons.indexOf(m[0])<0)icons.push(m[0])});
var wait=(S.rules||[]).filter(function(r){return r.status==="proposed"}).length;
return '<div class="aiconn"><button class="aich" onclick="openAI()" title="Manage connected AI apps"><span class="aistk">'+icons.slice(0,4).map(function(k){return '<i class="ail-'+k+'">'+aiSvg(k)+'</i>'}).join("")+'</span><span class="aichn"><b>'+esc(rm&&rm.on?"Your AI apps":names.join(" + "))+'</b><small>'+(rm&&rm.on&&!rm.online?'<span class="warn">●</span> Waiting for the wallet':rm&&rm.on&&!rm.used?'<span class="warn">●</span> Add the address to your AI app':'<span class="ok">●</span> Connected')+'</small></span></button>'+
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
// Adding a connector by its address. Steps checked against each app's docs on 2026-10-14: support.claude.com/en/articles/11175166,
// developers.openai.com/api/docs/guides/developer-mode, code.claude.com/docs/en/mcp-quickstart, cursor.com/docs/mcp,
// code.visualstudio.com/docs/copilot/reference/mcp-configuration, developers.openai.com/codex/mcp, geminicli.com/docs/tools/mcp-server.
var AIREMOTE=[
{id:"claude",name:"Claude",sub:"Add it on the web or desktop app",icon:"claude",open:"https://claude.ai/customize/connectors",hand:function(u){return '<ol class="aist"><li>Open <a href="https://claude.ai/customize/connectors" target="_blank" rel="noopener">claude.ai/customize/connectors</a>, click <b>+</b>, then <b>Add custom connector</b>.</li><li>Paste your address and click <b>Add</b>.</li></ol><p class="aismall">Free plans can add one custom connector. On Team and Enterprise, an Owner adds it (Add → Custom → Web).</p>'}},
{id:"chatgpt",name:"ChatGPT",sub:"Developer mode, paid plans, on the web",icon:"terminal",open:"https://chatgpt.com/",hand:function(u){return '<ol class="aist"><li>In ChatGPT on the web: <b>Settings → Apps → Advanced settings</b>, turn on <b>Developer mode</b>.</li><li>Click <b>Create app</b>, paste your address, choose <b>No authentication</b>, and create it.</li></ol><p class="aismall">Developer mode depends on your ChatGPT plan; OpenAI’s help pages list which.</p>'}},
{id:"claude-code",name:"Claude Code",sub:"Terminal",icon:"claude",hand:function(u){return '<p class="aip">Paste into your terminal:</p>'+aiCode("ar-cc","claude mcp add --transport http --scope user tollkit-wallet "+shq(u))}},
{id:"cursor",name:"Cursor",sub:"Code editor",icon:"cursor",hand:function(u){return '<p class="aip">Add this to <span class="kbd">~/.cursor/mcp.json</span>:</p>'+aiCode("ar-cu",JSON.stringify({mcpServers:{"tollkit-wallet":{url:u}}},null,2))}},
{id:"vscode",name:"VS Code",sub:"With GitHub Copilot",icon:"copilot",hand:function(u){return '<p class="aip">Run <b>MCP: Add Server</b>, choose <b>HTTP</b> and paste your address. Or add to <span class="kbd">mcp.json</span>:</p>'+aiCode("ar-vs",JSON.stringify({servers:{"tollkit-wallet":{type:"http",url:u}}},null,2))}},
{id:"codex",name:"Codex",sub:"OpenAI’s terminal agent",icon:"terminal",hand:function(u){return '<p class="aip">Add to <span class="kbd">~/.codex/config.toml</span>:</p>'+aiCode("ar-cx",'[mcp_servers.tollkit_wallet]\nurl = "'+u+'"')}},
{id:"gemini",name:"Gemini CLI",sub:"Terminal",icon:"gemini",hand:function(u){return '<p class="aip">Paste into your terminal:</p>'+aiCode("ar-gm","gemini mcp add -s user --transport http tollkit-wallet "+shq(u))}}
];
function aiRemote(r){var h='<h2>Connect your AI</h2><p class="ailead">Let Claude, ChatGPT, Cursor or another AI app use this wallet. It follows your limits, can’t withdraw or see your keys, and any rules it suggests wait in Autopilot for you.</p>',m=AIMSG.remote;
if(!r.on)return h+'<label class="ailbl" for="aipw">Wallet password</label><input id="aipw" class="aiin" type="password" autocomplete="current-password" placeholder="Needed to turn this on" value="'+esc(AIPW)+'">'+
'<button class="b aigoap" data-ract="on"'+(AIBUSY?" disabled":"")+'>'+(AIBUSY?"Making it…":"Make my connector address")+'</button>'+(m?'<div class="aim '+(m[0]?"ok":"bad")+'">'+esc(m[1])+'</div>':'')+
'<p class="aismall">You get a private web address to add to your AI app. Tollkit’s server passes the app’s requests to this wallet while Chrome is open and the wallet is unlocked. Your keys stay here.</p>';
h+='<label class="ailbl">Your connector address</label>'+aiCode("ai-url",r.url)+
(r.used?'<div class="aidone aiok"><b>✓ Connected.</b> Your AI app reached the wallet '+esc(ago(new Date(r.used).toISOString()))+'.</div>':'')+
'<p class="aismall"><span class="'+(r.online?"ok":"warn")+'">●</span> '+(!r.online?"Waiting for the wallet to check in…":r.used?"The wallet is reachable.":"The wallet is ready. Add the address to your AI app below, then ask it something. This turns to Connected when it does.")+' Anyone with this address can use the wallet within your limits, so keep it private.</p>'+
'<div class="ailist">'+AIREMOTE.map(function(x,i){return '<div class="airow" style="--i:'+i+'"><div class="airt">'+aiSvg(x.icon)+'<div class="ainm"><b>'+esc(x.name)+'</b><small>'+esc(x.sub)+'</small></div></div><div class="aiacts">'+(x.open?'<button class="botcta aicopen" data-copen="'+x.id+'">'+(AICOPIED===x.id?"Copied. Paste it there ✓":"Copy & open "+esc(x.name)+ARROW)+'</button>':'')+'<button class="aihand" data-hand="r-'+x.id+'">'+(AIOPEN["r-"+x.id]?"Hide steps":"How to add it")+'</button></div>'+(AIOPEN["r-"+x.id]?'<div class="aihb">'+x.hand(r.url)+'</div>':'')+'</div>'}).join("")+'</div>'+
'<div class="aidone"><b>Check it worked.</b> Ask your AI: <b>“What’s in my Tollkit wallet?”</b></div>'+
'<label class="ailbl" for="aipw">Wallet password (for a new address)</label><input id="aipw" class="aiin" type="password" autocomplete="current-password" value="'+esc(AIPW)+'">'+
'<div class="btns" style="margin-top:10px"><button class="b g" data-ract="new"'+(AIBUSY?" disabled":"")+'>New address</button><button class="b no" data-ract="off"'+(AIBUSY?" disabled":"")+'>Turn off</button></div>'+(m?'<div class="aim '+(m[0]?"ok":"bad")+'">'+esc(m[1])+'</div>':'')+
'<p class="aismall">A new address stops the old one. Turning off stops every app.</p>';
return h}
function aiRemoteDo(act){if(act!=="off"&&!AIPW){AIMSG.remote=[0,"Type your wallet password first."];aiRender();document.getElementById("aipw").focus();return}
AIBUSY="remote";AIMSG.remote=null;aiRender();api("/connect/remote",{password:AIPW,action:act}).then(function(){AIPW="";AIMSG.remote=act==="off"?[1,"Turned off. No app can reach the wallet now."]:act==="new"?[1,"New address made. Add it to your apps again."]:null;return refresh()}).catch(function(e){AIMSG.remote=[0,e.message]}).then(function(){AIBUSY=null;aiRender()})}
function aiRender(){if(!AIO)return;var c=S.connect||{},foc=document.activeElement&&document.activeElement.id==="aipw";
if(c.remote){var sc0=AIO.querySelector(".aidlg").scrollTop;AIO.querySelector(".aibody").innerHTML=aiRemote(c.remote);AIO.querySelector(".aidlg").scrollTop=sc0;var pw0=document.getElementById("aipw");if(pw0){pw0.oninput=function(){AIPW=pw0.value};if(foc)pw0.focus()}return}
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
function aiClick(e){var t=e.target.closest("button,a");if(!t)return;if(t.classList.contains("aix"))closeAI();else if(t.hasAttribute("data-ract"))aiRemoteDo(t.getAttribute("data-ract"));else if(t.hasAttribute("data-copen")){var xo=AIREMOTE.filter(function(z){return z.id===t.getAttribute("data-copen")})[0],ru=((S.connect||{}).remote||{}).url;if(xo&&ru){if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(ru).catch(function(){fallback(ru)});else fallback(ru);AICOPIED=xo.id;AIOPEN["r-"+xo.id]=true;aiRender();window.open(xo.open,"_blank")}}else if(t.hasAttribute("data-act"))aiDo(t.getAttribute("data-act"),t.getAttribute("data-id"));else if(t.hasAttribute("data-hand")){var k=t.getAttribute("data-hand");AIOPEN[k]=!AIOPEN[k];aiRender()}else if(t.hasAttribute("data-copy")){var el=document.getElementById(t.getAttribute("data-copy")),v=el?el.textContent:"",done=function(){t.textContent="Copied";setTimeout(function(){t.textContent="Copy"},1500)};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(done,function(){fallback(v);done()});else{fallback(v);done()}}}
document.addEventListener("keydown",function(e){if(AIO&&e.key==="Escape")closeAI()});
var BUY={o:null,chain:null,asset:"USDC",amt:"50",custom:"",test:false,err:null,busy:false,done:null};
var BUYA={base:["USDC","ETH"],ethereum:["USDC","ETH"],solana:["USDC","SOL"]};
// Coinbase buy and cash out: Base, Ethereum and Solana (Arbitrum and Polygon wait for Coinbase's network names to be confirmed).
function rampChains(){var ch=((S.policy&&S.policy.chains)||["base"]).filter(function(c){return BUYA[c]});return ch.length?ch:["base"]}
var WICO={buy:'<path d="M12 5v14M5 12h14"/>',receive:'<path d="M12 4v12m0 0l-5-5m5 5l5-5M5 20h14"/>',stake:'<path d="M4 17l6-6 4 4 6-6M14 9h6v6"/>',move:'<path d="M7 7h12l-3-3M17 17H5l3 3"/>',sell:'<path d="M12 3v18M16.5 7.5c0-1.7-2-2.8-4.5-2.8S7.5 5.8 7.5 7.5s2 2.5 4.5 3 4.5 1.3 4.5 3.2-2 3-4.5 3-4.5-1.1-4.5-2.9"/>'};
function wTile(k,label,fn){return '<button class="wtile" onclick="'+fn+'"><i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+WICO[k]+'</svg></i>'+label+'</button>'}
function walletActions(){var ch=(S.policy&&S.policy.chains)||[];return '<div class="wact">'+wTile("buy","Buy","openBuy()")+wTile("sell","Sell","openSell()")+wTile("receive","Receive","goReceive()")+(ch.length>1?wTile("move","Move","openMove()"):"")+(ch.indexOf("solana")>=0?wTile("stake","Stake","openStake()"):"")+'</div>'}
function goReceive(){var h=[].slice.call(document.querySelectorAll("#main h3")).filter(function(x){return /Deposit/.test(x.textContent)})[0];if(h)h.scrollIntoView({behavior:"smooth",block:"start"})}
function openBuy(){var ch=rampChains();BUY.chain=BUY.chain&&ch.indexOf(BUY.chain)>=0?BUY.chain:ch[0];if(BUYA[BUY.chain].indexOf(BUY.asset)<0)BUY.asset="USDC";BUY.err=null;BUY.done=null;BUY.busy=false;if(!BUY.o){BUY.o=document.createElement("div");BUY.o.className="aio";BUY.o.innerHTML='<div class="aidlg" role="dialog" aria-modal="true" aria-label="Buy crypto"><button class="aix" aria-label="Close">×</button><div class="aibody"></div></div>';BUY.o.addEventListener("mousedown",function(e){if(e.target===BUY.o)closeBuy()});BUY.o.addEventListener("click",buyClick);document.body.appendChild(BUY.o)}buyRender()}
var STK={o:null,data:null,vals:null,err:null,ok:null,busy:null,amt:"",vote:"",pw:""};
function openStake(){STK.err=null;STK.ok=null;STK.busy=null;STK.pw="";if(!STK.o){STK.o=document.createElement("div");STK.o.className="aio";STK.o.innerHTML='<div class="aidlg" role="dialog" aria-modal="true" aria-label="Stake SOL"><button class="aix" aria-label="Close">×</button><div class="aibody"></div></div>';STK.o.addEventListener("mousedown",function(e){if(e.target===STK.o)closeStake()});STK.o.addEventListener("click",stkClick);document.body.appendChild(STK.o)}stkRender();stkLoad();if(!STK.vals)api("/validators").then(function(r){STK.vals=r.validators;stkRender()}).catch(function(e){STK.err=e.message;stkRender()})}
function closeStake(){if(STK.o){STK.o.remove();STK.o=null}}
document.addEventListener("keydown",function(e){if(STK.o&&e.key==="Escape")closeStake()});
function stkLoad(){return api("/stake").then(function(d){STK.data=d;stkRender()}).catch(function(e){STK.err=e.message;stkRender()})}
function sol(l){var n=Number(l)/1e9;return n.toLocaleString(undefined,{maximumFractionDigits:n<1?6:4})+" SOL"}
function hrs(s){s=Number(s)||0;return s>=3600?"about "+Math.round(s/3600)+" h":"about "+Math.max(1,Math.round(s/60))+" min"}
var STLBL={activating:["Starting","stc"],active:["Earning","stc active"],deactivating:["Unstaking","stc"],inactive:["Ready to withdraw","stc ready"]};
function stkRender(){if(!STK.o)return;var d=STK.data,h='<h2>Stake SOL</h2><p class="ailead">Stake SOL with a validator to earn rewards. It stays under this wallet\'s control: unstake any time, then withdraw once the current epoch ends.</p>';
if(!d)h+='<div class="sm mut">Loading your stakes…</div>';else{
h+='<div class="ailbl">Your stakes</div>'+(d.accounts.length?d.accounts.map(function(a){var lb=STLBL[a.status]||[a.status,"stc"];var act=a.status==="active"||a.status==="activating"?'<button class="b g sbtn" data-su="'+esc(a.address)+'"'+(STK.busy?" disabled":"")+'>Unstake</button>':a.status==="inactive"?'<button class="b sbtn" data-sw="'+esc(a.address)+'"'+(STK.busy?" disabled":"")+'>Withdraw</button>':"";
return '<div class="stk">'+tokIcon("SOL","solana")+'<div style="min-width:0"><div>'+sol(a.status==="inactive"?a.lamports:(a.delegated||a.lamports))+'</div><div class="sm mut" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.validator||(a.voter?short(a.voter):"Not delegated"))+'</div></div><div class="r"><span class="'+lb[1]+'">'+lb[0]+'</span>'+act+'</div></div>'}).join(""):'<div class="sm mut">No stakes yet.</div>')+
'<div class="stnote">Epoch '+d.epoch.epoch+' ends in '+hrs(d.epoch.seconds_left)+'. New stakes start earning, and unstaked SOL can be withdrawn, after it ends.</div>'}
h+='<div class="ailbl" style="margin-top:16px">New stake</div><div class="grid2"><div><label for="stamt">Amount (SOL)</label><input id="stamt" inputmode="decimal" placeholder="'+(d?d.min_delegation/1e9:1)+' or more" value="'+esc(STK.amt)+'" oninput="STK.amt=this.value.replace(/[^0-9.]/g,\'\')"></div><div><label for="stval">Validator</label><select id="stval" onchange="STK.vote=this.value">'+(STK.vals?'<option value="">Pick one</option>'+STK.vals.map(function(v){return '<option value="'+esc(v.vote)+'"'+(STK.vote===v.vote?" selected":"")+'>'+esc((v.name||short(v.vote))+" · "+v.commission+"% fee")+'</option>'}).join(""):'<option value="">Loading…</option>')+'</select></div></div>'+
'<div class="stnote">Validators are listed by how much SOL is staked with them. The fee is the share of rewards the validator keeps. '+(d?'About '+sol(d.rent_reserve)+' stays in the stake account for rent and comes back when you withdraw.':'')+'</div>'+
'<label for="stpw">Password</label><input id="stpw" type="password" autocomplete="current-password" value="'+esc(STK.pw)+'" oninput="STK.pw=this.value">'+
(STK.err?'<div class="msg err">'+esc(STK.err)+'</div>':'')+(STK.ok?'<div class="msg okk">'+esc(STK.ok)+'</div>':'')+
'<button class="b aigoap" data-sgo'+(STK.busy?" disabled":"")+'>'+(STK.busy==="stake"?"Staking…":"Stake")+'</button>';
var fid=document.activeElement&&document.activeElement.id,body=STK.o.querySelector(".aibody");body.innerHTML=h;if(fid&&/^st(amt|pw)$/.test(fid)){var i=document.getElementById(fid);i.focus();i.setSelectionRange(i.value.length,i.value.length)}}
function stkClick(e){var t=e.target.closest("button");if(!t)return;if(t.classList.contains("aix"))return closeStake();
if(t.hasAttribute("data-sgo"))stkDo({action:"stake",sol:Number(STK.amt),vote:STK.vote});
else if(t.hasAttribute("data-su"))stkDo({action:"unstake",account:t.getAttribute("data-su")});
else if(t.hasAttribute("data-sw"))stkDo({action:"withdraw",account:t.getAttribute("data-sw")})}
function stkDo(b){STK.err=null;STK.ok=null;if(!STK.pw){STK.err="Enter your password.";stkRender();return}
if(b.action==="stake"){if(!(b.sol>0)){STK.err="Enter how much SOL to stake.";stkRender();return}if(!b.vote){STK.err="Pick a validator.";stkRender();return}}
b.password=STK.pw;STK.busy=b.action;stkRender();
api("/stake",b).then(function(){STK.busy=null;STK.pw="";if(b.action==="stake")STK.amt="";STK.ok=b.action==="stake"?"Staked. It starts earning after this epoch ends.":b.action==="unstake"?"Unstaking. You can withdraw it after this epoch ends.":"Withdrawn to your wallet.";stkLoad();refresh();loadBal()}).catch(function(e){STK.busy=null;STK.err=e.message;stkRender()})}
var MV={o:null,asset:"USDC",from:null,to:null,amt:"",pw:"",q:null,qerr:null,qbusy:false,err:null,ok:null,busy:false,moves:null,t:null,seq:0};
function mvChains(){var ch=(S.policy&&S.policy.chains)||[];return MV.asset==="ETH"?ch.filter(function(c){return c==="base"||c==="ethereum"}):ch}
function openMove(){MV.err=null;MV.ok=null;MV.busy=false;MV.pw="";var ch=mvChains();if(ch.indexOf(MV.from)<0)MV.from=ch[0];if(ch.indexOf(MV.to)<0||MV.to===MV.from)MV.to=ch.filter(function(c){return c!==MV.from})[0];
if(!MV.o){MV.o=document.createElement("div");MV.o.className="aio";MV.o.innerHTML='<div class="aidlg" role="dialog" aria-modal="true" aria-label="Move between networks"><button class="aix" aria-label="Close">×</button><div class="aibody"></div></div>';MV.o.addEventListener("mousedown",function(e){if(e.target===MV.o)closeMove()});MV.o.addEventListener("click",mvClick);document.body.appendChild(MV.o)}mvRender();mvMoves();mvQuote()}
function closeMove(){if(MV.o){MV.o.remove();MV.o=null}}
document.addEventListener("keydown",function(e){if(MV.o&&e.key==="Escape")closeMove()});
function mvMoves(){api("/moves").then(function(r){MV.moves=r.moves;mvRender()}).catch(function(){})}
function mvHave(c,a){var BL=(S.live&&S.live.balances&&Object.keys(S.live.balances).length)?S.live.balances:B;var r=BL&&BL[c];if(!r||r.error)return null;for(var i=0;i<r.length;i++)if(r[i].token===a)return Number(r[i].amount);return null}
function mvQuote(){clearTimeout(MV.t);MV.q=null;MV.qerr=null;var a=Number(MV.amt);if(!(a>0)||!MV.from||!MV.to){MV.qbusy=false;mvRender();return}MV.qbusy=true;mvRender();var my=++MV.seq;
MV.t=setTimeout(function(){api("/move/quote?asset="+MV.asset+"&from="+MV.from+"&to="+MV.to+"&amount="+encodeURIComponent(MV.amt)).then(function(q){if(my!==MV.seq)return;MV.q=q;MV.qbusy=false;mvRender()}).catch(function(e){if(my!==MV.seq)return;MV.qerr=e.message;MV.qbusy=false;mvRender()})},450)}
function mvAmt(atomic){var d=MV.asset==="USDC"?6:18,n=Number(atomic)/Math.pow(10,d);return n.toLocaleString(undefined,{maximumFractionDigits:MV.asset==="USDC"?2:6})+" "+MV.asset}
function eta(s){s=Number(s)||0;return s<90?"about "+Math.max(5,Math.round(s/5)*5)+" seconds":"about "+Math.round(s/60)+" minutes"}
var MVST={sent:["On the way","stc"],arrived:["Arrived","stc active"],failed:["Failed","stc"]};
function mvRender(){if(!MV.o)return;var ch=mvChains(),have=MV.from?mvHave(MV.from,MV.asset):null,q=MV.q;
var seg=function(attr,list,cur){return '<div class="bseg">'+list.map(function(c){return '<button '+attr+'="'+c+'" class="bsb'+(cur===c?" on":"")+'">'+chainIcon(c)+esc(CHAIN_NAMES[c]||c)+'</button>'}).join("")+'</div>'};
var h='<h2>Move between networks</h2><p class="ailead">Send your own '+(MV.asset==="ETH"?"ETH":"USDC")+' from one network to another. It arrives at this wallet\'s address there.</p>'+
'<div class="ailbl">Coin</div><div class="bseg">'+["USDC","ETH"].map(function(a){return '<button data-ma="'+a+'" class="bsb'+(MV.asset===a?" on":"")+'">'+tokIcon(a)+a+'</button>'}).join("")+'</div>'+
'<div class="ailbl">From</div>'+seg("data-mf",ch,MV.from)+'<div class="ailbl">To</div>'+seg("data-mt",ch.filter(function(c){return c!==MV.from}),MV.to)+
'<div class="ailbl">Amount</div><div class="mvamt"><input id="mvamt" inputmode="decimal" placeholder="0.00" value="'+esc(MV.amt)+'" oninput="MV.amt=this.value.replace(/[^0-9.]/g,\'\');mvQuote()"><span class="mut sm">'+MV.asset+'</span>'+(have!==null&&MV.asset==="USDC"&&have>0?'<button class="b g sbtn" data-mmax>Max</button>':'')+'</div>'+
(have!==null?'<div class="sm mut" style="margin-top:6px">Available on '+esc(CHAIN_NAMES[MV.from]||MV.from)+': '+have.toLocaleString(undefined,{maximumFractionDigits:MV.asset==="USDC"?2:6})+' '+MV.asset+'</div>':'');
if(MV.qbusy)h+='<div class="mvq sm mut">Getting a price…</div>';
else if(MV.qerr)h+='<div class="msg err">'+esc(MV.qerr)+'</div>';
else if(q)h+='<div class="mvq"><div class="mvr"><span>You send</span><b>'+mvAmt(q.amount)+'</b></div><div class="mvr"><span>Tollkit fee (0.25%)</span><span>'+mvAmt(q.tollkit_fee)+'</span></div><div class="mvr"><span>'+(q.via==="cctp"?"Circle's fee, up to":"Across fees")+'</span><span>'+mvAmt(q.bridge_fee_max)+'</span></div><div class="mvr tot"><span>You get at least</span><b>'+mvAmt(q.receive_min)+'</b></div><div class="mvr"><span>Arrives in</span><span>'+eta(q.eta_seconds)+'</span></div></div>'+
'<div class="stnote">'+(q.via==="cctp"?'Uses Circle\'s own USDC transfer (CCTP): USDC is burned here and minted there by Circle, who also pays the network fee on arrival.'+(MV.from==="solana"?" About 0.003 SOL goes to a record account Circle requires.":" Needs a little "+NATIVE[MV.from]+" on "+esc(CHAIN_NAMES[MV.from])+" for network fees."):'Powered by Across. By moving you agree to <a href="https://across.to/terms-of-service" target="_blank" rel="noopener">Across\'s terms</a>. Needs a little extra ETH for the network fee.')+'</div>';
h+='<label for="mvpw">Password</label><input id="mvpw" type="password" autocomplete="current-password" value="'+esc(MV.pw)+'" oninput="MV.pw=this.value">'+
(MV.err?'<div class="msg err">'+esc(MV.err)+'</div>':'')+(MV.ok?'<div class="msg okk">'+esc(MV.ok)+'</div>':'')+
'<button class="b aigoap" data-mgo'+(MV.busy||!q?" disabled":"")+'>'+(MV.busy?"Moving…":"Move"+(q?" "+mvAmt(q.amount):""))+'</button>';
if(MV.moves&&MV.moves.length)h+='<div class="ailbl" style="margin-top:18px">Recent moves</div>'+MV.moves.slice(0,5).map(function(m){var st=MVST[m.state]||[m.state,"stc"],d=m.asset==="USDC"?6:18;var amt=(Number(m.amount)/Math.pow(10,d)).toLocaleString(undefined,{maximumFractionDigits:m.asset==="USDC"?2:6})+" "+m.asset;
var link=EXP[m.from]?' · <a target="_blank" rel="noopener" href="'+EXP[m.from]+esc(m.tx)+'">sent</a>':"";var link2=m.dest_tx&&EXP[m.to]?' · <a target="_blank" rel="noopener" href="'+EXP[m.to]+esc(m.dest_tx)+'">arrived</a>':"";
return '<div class="stk">'+tokIcon(m.asset)+'<div style="min-width:0"><div>'+amt+'</div><div class="sm mut">'+esc(CHAIN_NAMES[m.from]||m.from)+' → '+esc(CHAIN_NAMES[m.to]||m.to)+' · '+ago(m.ts)+link+link2+'</div></div><div class="r"><span class="'+st[1]+'">'+st[0]+'</span></div></div>'}).join("");
var fid=document.activeElement&&document.activeElement.id;MV.o.querySelector(".aibody").innerHTML=h;if(fid==="mvamt"||fid==="mvpw"){var i=document.getElementById(fid);i.focus();i.setSelectionRange(i.value.length,i.value.length)}}
function mvClick(e){var t=e.target.closest("button");if(!t)return;if(t.classList.contains("aix"))return closeMove();
if(t.hasAttribute("data-ma")){MV.asset=t.getAttribute("data-ma");var ch=mvChains();if(ch.indexOf(MV.from)<0)MV.from=ch[0];if(ch.indexOf(MV.to)<0||MV.to===MV.from)MV.to=ch.filter(function(c){return c!==MV.from})[0];mvQuote()}
else if(t.hasAttribute("data-mf")){MV.from=t.getAttribute("data-mf");if(MV.to===MV.from)MV.to=mvChains().filter(function(c){return c!==MV.from})[0];mvQuote()}
else if(t.hasAttribute("data-mt")){MV.to=t.getAttribute("data-mt");mvQuote()}
else if(t.hasAttribute("data-mmax")){var hv=mvHave(MV.from,MV.asset);if(hv)MV.amt=String(Math.floor(hv*100)/100);mvQuote()}
else if(t.hasAttribute("data-mgo"))mvGo()}
function mvGo(){MV.err=null;MV.ok=null;if(!MV.pw){MV.err="Enter your password.";mvRender();return}MV.busy=true;mvRender();
api("/move",{password:MV.pw,asset:MV.asset,from:MV.from,to:MV.to,amount:MV.amt,receive_min:MV.q?MV.q.receive_min:undefined}).then(function(r){MV.busy=false;MV.pw="";MV.amt="";MV.q=null;MV.ok="Sent. It should arrive in "+eta(r.move.eta_seconds)+".";mvMoves();refresh();loadBal()}).catch(function(e){MV.busy=false;MV.err=e.message;if(/price changed/.test(e.message))mvQuote();else mvRender()})}
setInterval(function(){if(MV.o&&MV.moves&&MV.moves.some(function(m){return m.state==="sent"}))mvMoves()},10000);
var SL={o:null,chain:null,asset:"USDC",amt:"",err:null,busy:false,ref:null,sale:null,tx:null,pw:"",ok:null,t:null};
function openSell(){var ch=rampChains();if(ch.indexOf(SL.chain)<0)SL.chain=ch[0];if(BUYA[SL.chain].indexOf(SL.asset)<0)SL.asset="USDC";SL.err=null;SL.ok=null;SL.busy=false;
if(!SL.o){SL.o=document.createElement("div");SL.o.className="aio";SL.o.innerHTML='<div class="aidlg" role="dialog" aria-modal="true" aria-label="Cash out"><button class="aix" aria-label="Close">×</button><div class="aibody"></div></div>';SL.o.addEventListener("mousedown",function(e){if(e.target===SL.o)closeSell()});SL.o.addEventListener("click",slClick);document.body.appendChild(SL.o)}
if(!SL.ref)api("/sells").then(function(r){var open=(r.sales||[]).filter(function(x){return (x.state==="open"||x.state==="sent")&&Date.now()-Date.parse(x.ts)<3600000})[0];if(open&&!SL.ref){SL.ref=open.ref;SL.sale=open;slPoll()}else slRender()}).catch(function(){});slRender();if(SL.ref)slPoll()}
function closeSell(){if(SL.o){SL.o.remove();SL.o=null}clearTimeout(SL.t)}
document.addEventListener("keydown",function(e){if(SL.o&&e.key==="Escape")closeSell()});
function slPoll(){clearTimeout(SL.t);if(!SL.ref||!SL.o)return;api("/sell/status?ref="+SL.ref).then(function(r){SL.sale=r.sale;SL.tx=r.transaction;slRender();var st=SL.sale&&SL.sale.state;if(st==="open"||st==="sent")SL.t=setTimeout(slPoll,st==="sent"?10000:4000)}).catch(function(e){SL.err=e.message;slRender();SL.t=setTimeout(slPoll,10000)})}
function slLeft(t){var at=Date.parse(t.updated_at||t.created_at||"");if(!isFinite(at))return "";var m=Math.max(0,Math.round((at+1800000-Date.now())/60000));return m+" min left to send"}
function slRender(){if(!SL.o)return;var ch=rampChains(),h='<h2>Cash out</h2>';var sale=SL.sale,t=SL.tx;
if(!SL.ref){var have=mvHave(SL.chain,SL.asset);
h+='<p class="ailead">Sell crypto to your bank or PayPal with Coinbase. You\'ll need a Coinbase account. Coinbase shows its fee and the payout before you confirm.</p>'+
'<div class="ailbl">Network</div><div class="bseg">'+ch.map(function(c){return '<button data-sc="'+c+'" class="bsb'+(SL.chain===c?" on":"")+'">'+chainIcon(c)+esc(CHAIN_NAMES[c]||c)+'</button>'}).join("")+'</div>'+
'<div class="ailbl">Coin</div><div class="bseg">'+BUYA[SL.chain].map(function(a){return '<button data-sa="'+a+'" class="bsb'+(SL.asset===a?" on":"")+'">'+tokIcon(a)+esc(a)+'</button>'}).join("")+'</div>'+
'<div class="ailbl">Amount</div><div class="mvamt"><input id="slamt" inputmode="decimal" placeholder="How much to sell" value="'+esc(SL.amt)+'" oninput="SL.amt=this.value.replace(/[^0-9.]/g,\'\')"><span class="mut sm">'+SL.asset+'</span></div>'+
(have!==null?'<div class="sm mut" style="margin-top:6px">Available: '+have.toLocaleString(undefined,{maximumFractionDigits:6})+' '+SL.asset+'</div>':'')+
(SL.err?'<div class="msg err">'+esc(SL.err)+'</div>':'')+'<button class="b aigoap" data-sgo2'+(SL.busy?" disabled":"")+'>'+(SL.busy?"Opening Coinbase…":"Continue to Coinbase")+'</button>'}
else{var st=sale&&sale.state;
if(st==="sent"||st==="sending"||st==="done"){h+='<p class="ailead">'+(st==="done"?"Done. Coinbase has paid out"+(sale.payout?" "+esc(sale.payout):"")+".":"Sent to Coinbase. It pays out once the transfer confirms, usually within a few minutes.")+'</p>'+(sale.tx&&EXP[sale.chain]?'<div class="sm"><a target="_blank" rel="noopener" href="'+EXP[sale.chain]+esc(sale.tx)+'">View the transfer</a></div>':'')+'<button class="b g aigoap" data-snew>Start another cash out</button>'}
else if(st==="failed"||st==="expired"){h+='<p class="ailead">This cash out '+(st==="failed"?"failed on Coinbase.":"expired.")+' Nothing was sent from this wallet unless Activity shows it.</p><button class="b aigoap" data-snew>Start again</button>'}
else if(t&&/STARTED/.test(t.status)&&t.to_address){var amt=t.sell_amount?t.sell_amount.value+" "+t.sell_amount.currency:"";
h+='<p class="ailead">Coinbase is ready. Send the crypto to finish.</p><div class="mvq"><div class="mvr"><span>Send</span><b>'+esc(amt)+'</b></div><div class="mvr"><span>On</span><span>'+esc(CHAIN_NAMES[t.network]||t.network)+'</span></div><div class="mvr"><span>To Coinbase</span></div><div class="addr sm" style="margin:0 0 6px">'+esc(t.to_address)+'</div>'+(t.coinbase_fee&&t.coinbase_fee.value?'<div class="mvr"><span>Coinbase fee</span><span>'+esc(t.coinbase_fee.value+" "+t.coinbase_fee.currency)+'</span></div>':'')+(t.total&&t.total.value?'<div class="mvr tot"><span>You get</span><b>'+esc(t.total.value+" "+t.total.currency)+'</b></div>':'')+'</div>'+
'<div class="stnote">'+esc(slLeft(t))+'. Network fees are paid from this wallet.</div><label for="slpw">Password</label><input id="slpw" type="password" autocomplete="current-password" value="'+esc(SL.pw)+'" oninput="SL.pw=this.value">'+
(SL.err?'<div class="msg err">'+esc(SL.err)+'</div>':'')+'<button class="b aigoap" data-ssend'+(SL.busy?" disabled":"")+'>'+(SL.busy?"Sending…":"Send "+esc(amt)+" to Coinbase")+'</button><button class="b g aigoap" data-snew>Cancel</button>'}
else{h+='<p class="ailead">Finish on Coinbase: sign in, choose where the money goes, and click <b>Cash out now</b>. Then come back here to send the crypto. This page checks every few seconds.</p><div class="sm mut">Waiting for Coinbase…</div>'+(SL.err?'<div class="msg err">'+esc(SL.err)+'</div>':'')+'<button class="b g aigoap" data-snew>Cancel</button>'}}
var fid=document.activeElement&&document.activeElement.id;SL.o.querySelector(".aibody").innerHTML=h;if(fid==="slamt"||fid==="slpw"){var i=document.getElementById(fid);i.focus();i.setSelectionRange(i.value.length,i.value.length)}}
function slClick(e){var t=e.target.closest("button");if(!t)return;if(t.classList.contains("aix"))return closeSell();
if(t.hasAttribute("data-sc")){SL.chain=t.getAttribute("data-sc");if(BUYA[SL.chain].indexOf(SL.asset)<0)SL.asset="USDC";slRender()}
else if(t.hasAttribute("data-sa")){SL.asset=t.getAttribute("data-sa");slRender()}
else if(t.hasAttribute("data-snew")){clearTimeout(SL.t);SL.ref=null;SL.sale=null;SL.tx=null;SL.err=null;SL.pw="";slRender()}
else if(t.hasAttribute("data-sgo2")){var amt=SL.amt.trim();if(!(Number(amt)>0)){SL.err="Enter how much to cash out.";slRender();return}var win=window.open("about:blank","_blank");SL.busy=true;SL.err=null;slRender();
api("/sell",{chain:SL.chain,asset:SL.asset,amount:amt}).then(function(r){SL.busy=false;SL.ref=r.ref;SL.sale={ref:r.ref,state:"open",chain:SL.chain,asset:SL.asset};if(win){win.opener=null;win.location.href=r.url}else window.open(r.url,"_blank","noopener");slRender();slPoll()}).catch(function(e){if(win)win.close();SL.busy=false;SL.err=e.message;slRender()})}
else if(t.hasAttribute("data-ssend")){if(!SL.pw){SL.err="Enter your password.";slRender();return}SL.busy=true;SL.err=null;slRender();
api("/sell/send",{password:SL.pw,ref:SL.ref}).then(function(){SL.busy=false;SL.pw="";slPoll();refresh();loadBal()}).catch(function(e){SL.busy=false;SL.err=e.message;slRender()})}}
function closeBuy(){if(BUY.o){BUY.o.remove();BUY.o=null}}
document.addEventListener("keydown",function(e){if(BUY.o&&e.key==="Escape")closeBuy()});
function buyRender(){if(!BUY.o)return;var ch=rampChains(),addr=BUY.chain==="solana"?S.addresses.solana:S.addresses.evm;
var h='<h2>Buy crypto</h2><p class="ailead">Pay by card or bank with Coinbase. The crypto goes straight to this wallet.</p>'+
'<div class="ailbl">Network</div><div class="bseg">'+ch.map(function(c){return '<button data-bc="'+c+'" class="bsb'+(BUY.chain===c?" on":"")+'">'+chainIcon(c)+esc(CHAIN_NAMES[c]||c)+'</button>'}).join("")+'</div>'+
'<div class="ailbl">Coin</div><div class="bseg">'+BUYA[BUY.chain].map(function(a){return '<button data-ba="'+a+'" class="bsb'+(BUY.asset===a?" on":"")+'">'+tokIcon(a)+esc(a)+'</button>'}).join("")+'</div>'+
'<div class="ailbl">Amount</div><div class="bseg">'+["25","50","100","250"].map(function(v){return '<button data-bm="'+v+'" class="bsb'+(BUY.amt===v&&!BUY.custom?" on":"")+'">$'+v+'</button>'}).join("")+'<input id="bcust" class="bcust" inputmode="decimal" placeholder="Other" value="'+esc(BUY.custom)+'" oninput="BUY.custom=this.value.replace(/[^0-9.]/g,\'\')"></div>'+
'<div class="sm mut" style="margin-top:12px">Sends to <span class="addr">'+esc(short(addr))+'</span> on '+esc(CHAIN_NAMES[BUY.chain]||BUY.chain)+'. Coinbase may ask you to sign in or confirm your ID. Tollkit never sees your payment details.</div>'+

(BUY.err?'<div class="msg err">'+esc(BUY.err)+'</div>':'')+(BUY.done?'<div class="msg okk">'+esc(BUY.done)+'</div>':'')+
'<button class="b aigoap" data-bgo'+(BUY.busy?" disabled":"")+'>'+(BUY.busy?"Opening Coinbase…":"Continue to Coinbase")+'</button>';
var f=document.activeElement&&document.activeElement.id==="bcust";BUY.o.querySelector(".aibody").innerHTML=h;if(f){var i=document.getElementById("bcust");i.focus();i.setSelectionRange(i.value.length,i.value.length)}}
function buyClick(e){var t=e.target.closest("button");if(!t)return;if(t.classList.contains("aix"))return closeBuy();
if(t.hasAttribute("data-bc")){BUY.chain=t.getAttribute("data-bc");if(BUYA[BUY.chain].indexOf(BUY.asset)<0)BUY.asset="USDC";buyRender()}
else if(t.hasAttribute("data-ba")){BUY.asset=t.getAttribute("data-ba");buyRender()}
else if(t.hasAttribute("data-bm")){BUY.amt=t.getAttribute("data-bm");BUY.custom="";buyRender()}
else if(t.hasAttribute("data-bgo"))buyGo()}
function buyGo(){var amt=BUY.custom?Number(BUY.custom):Number(BUY.amt);if(!(amt>=5&&amt<=10000)){BUY.err="Pick an amount from $5 to $10,000.";buyRender();return}
var win=window.open("about:blank","_blank");BUY.busy=true;BUY.err=null;BUY.done=null;buyRender();
api("/buy",{chain:BUY.chain,asset:BUY.asset,amount_usd:amt,sandbox:BUY.test}).then(function(r){BUY.busy=false;if(win){win.opener=null;win.location.href=r.url}else window.open(r.url,"_blank","noopener");BUY.done="Coinbase opened in a new tab"+(r.sandbox?" (test mode)":"")+". Your balance updates here once the crypto arrives.";buyRender()}).catch(function(e){if(win)win.close();BUY.busy=false;BUY.err=e.message;buyRender()})}
var CHT={o:null,coin:"",sym:"",chain:"",name:"",range:"1D",data:null,loading:false,err:null,table:false,hover:null};
function coinOf(chain,sym){var c=(S.coins||{})[chain]||{};return c[sym]||c[String(sym).toUpperCase()]||""}
function rowAttrs(coin,sym,chain,name){return coin?' rowc" tabindex="0" role="button" aria-label="'+esc((name||sym)+" price chart")+'" data-chart="'+esc(coin)+'" data-sym="'+esc(sym)+'" data-chain="'+esc(chain)+'" data-name="'+esc(name||sym)+'"':'"'}
function holdRows(){var H=S.holdings;if(!H)return {rows:"",tot:0,chg:0};var rows="",tot=0,chg=0;(H.tokens||[]).forEach(function(t){var a=Number(t.amount),val=t.usd||0;tot+=val;if(typeof t.change_24h==="number")chg+=val-val/(1+t.change_24h);
rows+='<div class="row'+rowAttrs(t.coin,t.symbol,t.chain,t.name)+'>'+tokIcon(t.symbol,t.chain,t.icon)+'<div style="min-width:0"><div class="tname">'+esc(t.name||t.symbol)+(t.trust==="unlisted"?' <span class="chip warn tbadge" title="Not on the wallet’s token list. Check it before you trade it.">Unverified</span>':'')+'</div><div class="sm">'+(typeof t.change_24h==="number"?'<span class="'+(t.change_24h>=0?"ok":"bad")+'">'+(t.change_24h>=0?"+":"")+(t.change_24h*100).toFixed(2)+'%</span><span class="mut"> · '+esc(CHAIN_NAMES[t.chain]||t.chain)+'</span>':'<span class="mut">'+esc(CHAIN_NAMES[t.chain]||t.chain)+'</span>')+'</div></div><div class="r"><div class="usdv">'+fmtUsd(val)+'</div><div class="sm mut">'+esc(fmtAmt(a))+' '+esc(t.symbol)+'</div></div></div>'});
return {rows:rows,tot:tot,chg:chg}}
function holdFoot(){var H=S.holdings;if(!H)return "";return '<div class="hfoot">'+(H.hidden?'<span>'+H.hidden+' token'+(H.hidden>1?"s":"")+' without a price hidden</span> · ':'')+'<button class="aihand" style="padding:0" onclick="addTok()">'+(ADDT?"Close":"Add a token")+'</button></div>'+(ADDT?addTokSheet():(ADDM&&ADDM[0]?'<div class="msg okk">'+esc(ADDM[1])+'</div>':''))}
var ADDT=false,ADDM=null,AT={chain:"base",q:"",res:null,chk:null,busy:false,timer:null,confirm:false,gen:0};
function addTok(){ADDT=!ADDT;ADDM=null;AT.res=null;AT.chk=null;AT.q="";AT.confirm=false;render();if(ADDT){setTimeout(function(){var q=document.getElementById("at_q");if(q)q.focus();atSearch()},30)}}
function addTokSheet(){return '<div class="row addt" style="display:block"><div class="sm mut">Search by name or symbol, or paste a contract or mint address. Every token gets Tollkit’s scam check before it\'s added.</div><div class="crow2"><select id="at_chain" onchange="AT.chain=this.value;AT.chk=null;atSearch()">'+ALLCH.map(function(c){return [c,CHAIN_NAMES[c]]}).map(function(o){return '<option value="'+o[0]+'"'+(AT.chain===o[0]?" selected":"")+'>'+o[1]+'</option>'}).join("")+'</select><input id="at_q" placeholder="USDC, Bonk, 0x…" autocomplete="off" spellcheck="false" value="'+esc(AT.q)+'" oninput="AT.q=this.value;clearTimeout(AT.timer);AT.timer=setTimeout(atSearch,300)"></div><div id="at_res">'+atResHtml()+'</div>'+(ADDM?'<div class="msg '+(ADDM[0]?"okk":"err")+'">'+esc(ADDM[1])+'</div>':'')+'</div>'}
function atBadge(t){return t.trust==="core"?'<span class="chip ok tbadge">Built in</span>':t.trust==="listed"?'<span class="chip tbadge">'+(t.chain==="solana"?"Jupiter verified":"Listed")+'</span>':'<span class="chip warn tbadge">Not verified</span>'}
function atResHtml(){if(AT.chk)return atCheckHtml(AT.chk);if(AT.busy)return '<div class="sm mut" style="padding:8px 2px">Searching…</div>';if(!AT.res)return "";var q=AT.q.trim(),isAddr=AT.chain==="solana"?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q):/^0x[0-9a-fA-F]{40}$/.test(q);
var h=AT.res.map(function(t,i){return '<button class="atrow" data-ati="'+i+'">'+tokIcon(t.symbol,t.chain,t.logo)+'<span class="atn"><b>'+esc(t.symbol)+'</b> '+atBadge(t)+'<small>'+esc(t.name)+' · '+esc(short(t.address))+'</small></span></button>'}).join("");
if(isAddr&&!AT.res.some(function(t){return t.address.toLowerCase()===q.toLowerCase()}))h='<button class="atrow" data-atq="1"><div class="ic tok"><span class="tl">?</span></div><span class="atn"><b>Check this address</b><small>'+esc(short(q))+'</small></span></button>'+h;
if(!h)h='<div class="sm mut" style="padding:8px 2px">No match. Paste the token’s address to check it.</div>';
return '<div class="atlist">'+h+'</div>'+(AT.chain==="solana"?'<div class="sm mut" style="text-align:right;margin-top:4px">Powered by Jupiter</div>':'<div class="sm mut" style="text-align:right;margin-top:4px">Superchain and Uniswap token lists</div>')}
function atPaint(){var el=document.getElementById("at_res");if(el)el.innerHTML=atResHtml();else render()}
function atSearch(){var c=AT.chain,q=AT.q,g=++AT.gen;AT.chk=null;AT.busy=true;atPaint();api("/tokens/search",{chain:c,q:q}).then(function(r){if(g!==AT.gen)return;AT.res=r.tokens||[];AT.busy=false;atPaint()}).catch(function(e){AT.busy=false;AT.res=[];ADDM=[0,e.message];atPaint()})}
function atCheck(addr){clearTimeout(AT.timer);var g=++AT.gen;AT.busy=false;ADDM=null;AT.confirm=false;AT.chk={loading:true,address:addr};atPaint();api("/tokens/check",{chain:AT.chain,address:addr}).then(function(r){if(g!==AT.gen)return;AT.chk=r.check;atPaint()}).catch(function(e){AT.chk=null;ADDM=[0,e.message];render()})}
function atCheckHtml(c){if(c.loading)return '<div class="ap" style="margin-top:8px"><div class="sm mut">Running Tollkit’s token check…</div></div>';var w=c.warnings||[],p=c.powers||[],f=c.facts||[];
return '<div class="ap atchk'+(w.length?" atwarn":"")+'" style="margin-top:8px"><div style="display:flex;align-items:center;gap:10px">'+tokIcon(c.symbol||"?",c.chain,c.logo)+'<div style="min-width:0"><b>'+esc(c.symbol||"Unknown")+'</b> '+atBadge(c)+'<div class="sm mut">'+esc(c.name||"")+' · '+esc(short(c.address))+'</div></div></div>'+
(w.length?'<div class="atw"><b>'+w.length+' warning'+(w.length>1?"s":"")+'</b><ul>'+w.map(function(x){return '<li>'+esc(x)+'</li>'}).join("")+'</ul></div>':'<div class="sm ok" style="margin-top:8px">No warnings from the check. That doesn’t make a token safe.</div>')+
(p.length?'<div class="sm" style="margin-top:8px"><b>What the issuer can do</b><ul>'+p.map(function(x){return '<li>'+esc(x)+'</li>'}).join("")+'</ul></div>':'')+
(f.length?'<div class="sm mut" style="margin-top:6px">'+f.map(esc).join(" ")+'</div>':'')+
'<div class="btns"><button class="b g" onclick="AT.chk=null;atPaint()">Back</button>'+(w.length?(AT.confirm?'<button class="b no" onclick="atAdd(true)">Yes, add it anyway</button>':'<button class="b no" onclick="AT.confirm=true;atPaint()">Add anyway</button>'):'<button class="b ok" onclick="atAdd(false)">Add</button>')+'</div>'+(w.length&&AT.confirm?'<div class="sm bad" style="margin-top:6px">Only add it if you know where it came from. Many scam tokens copy real names.</div>':'')+'</div>'}
function atAdd(confirm){var c=AT.chk;api("/tokens/add",{chain:c.chain,address:c.address,confirm:!!confirm}).then(function(r){if(r.needs_confirm){AT.chk=r.check;AT.confirm=true;atPaint();return}ADDT=false;AT.chk=null;ADDM=[1,"Added "+r.token.symbol+"."];refresh().then(function(){render()})}).catch(function(e){ADDM=[0,e.message];render()})}
document.addEventListener("error",function(e){var t=e.target;if(t&&t.classList&&t.classList.contains("tlogo")){var sp=document.createElement("span");sp.className="tl";sp.textContent=t.getAttribute("data-tl")||"?";t.replaceWith(sp)}},true);
document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-ati],[data-atq]");if(!b)return;if(b.hasAttribute("data-atq"))atCheck(AT.q.trim());else{var t=AT.res[Number(b.getAttribute("data-ati"))];if(t)atCheck(t.address)}});
document.addEventListener("click",function(e){var r=e.target.closest&&e.target.closest("[data-chart]");if(r)openChart(r.getAttribute("data-chart"),r.getAttribute("data-sym"),r.getAttribute("data-chain"),r.getAttribute("data-name"))});
document.addEventListener("keydown",function(e){if(e.key==="Enter"&&document.activeElement&&document.activeElement.hasAttribute&&document.activeElement.hasAttribute("data-chart")){var r=document.activeElement;openChart(r.getAttribute("data-chart"),r.getAttribute("data-sym"),r.getAttribute("data-chain"),r.getAttribute("data-name"))}if(CHT.o&&e.key==="Escape")closeChart()});
function openChart(coin,sym,chain,name){CHT.coin=coin;CHT.sym=sym;CHT.chain=chain;CHT.name=name;CHT.data=null;CHT.err=null;CHT.table=false;CHT.hover=null;if(!CHT.o){CHT.o=document.createElement("div");CHT.o.className="aio";CHT.o.innerHTML='<div class="aidlg chdlg" role="dialog" aria-modal="true" aria-label="Price chart"><button class="aix" aria-label="Close">×</button><div class="aibody"></div></div>';CHT.o.addEventListener("mousedown",function(e){if(e.target===CHT.o)closeChart()});CHT.o.addEventListener("click",function(e){var t=e.target.closest("button");if(!t)return;if(t.classList.contains("aix"))closeChart();else if(t.hasAttribute("data-rg")){CHT.range=t.getAttribute("data-rg");loadChart()}else if(t.hasAttribute("data-tbl")){CHT.table=!CHT.table;drawChart()}});document.body.appendChild(CHT.o)}loadChart()}
function closeChart(){if(CHT.o){CHT.o.remove();CHT.o=null}}
function loadChart(){CHT.loading=true;CHT.err=null;drawChart();var want=CHT.coin+CHT.range;fetch("/api/chart?coin="+encodeURIComponent(CHT.coin)+"&range="+CHT.range,{headers:{"x-tw-token":T}}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||"HTTP "+r.status);return j})}).then(function(j){if(want!==CHT.coin+CHT.range)return;CHT.data=j;CHT.loading=false;CHT.hover=null;drawChart()}).catch(function(e){CHT.err=e.message;CHT.loading=false;drawChart()})}
function fmtP(p){return "$"+Number(p).toLocaleString(undefined,{maximumFractionDigits:p>=100?2:p>=1?4:p>=0.01?5:8,minimumFractionDigits:p>=100?2:0})}
function fmtT(t,rg){var d=new Date(t*1000);return rg==="1D"?d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):rg==="1Y"?d.toLocaleDateString([],{month:"short",day:"numeric",year:"numeric"}):d.toLocaleDateString([],{month:"short",day:"numeric"})+(rg==="1W"?" "+d.toLocaleTimeString([],{hour:"numeric"}):"")}
function drawChart(){if(!CHT.o)return;var D=CHT.data,P=D&&D.points||[],W=Math.max(260,((CHT.o.querySelector(".aibody")||{}).clientWidth||496)-18),H=200,pad={l:6,r:6,t:12,b:18};
var head='<div class="chh">'+tokIcon(CHT.sym,CHT.chain)+'<div><h2>'+esc(CHT.name)+'</h2><div class="sm mut">'+esc(CHT.sym)+' · '+esc(CHAIN_NAMES[CHT.chain]||CHT.chain)+'</div></div></div>';
var rg='<div class="chr" role="group" aria-label="Time range">'+["1D","1W","1M","1Y"].map(function(r){return '<button data-rg="'+r+'" class="chrb'+(CHT.range===r?" on":"")+'" aria-pressed="'+(CHT.range===r)+'">'+r+'</button>'}).join("")+'</div>';
if(!P.length){CHT.o.querySelector(".aibody").innerHTML=head+'<div class="chhero"><span class="skel" style="width:120px"></span></div>'+rg+'<div class="chbox">'+(CHT.err?'<div class="msg err">'+esc(CHT.err)+'</div>':'<div class="mut sm" style="padding:80px 0;text-align:center">Loading prices…</div>')+'</div>';return}
var first=P[0].p,last=P[P.length-1].p,chg=(last-first)/first,mn=Math.min.apply(null,P.map(function(x){return x.p})),mx=Math.max.apply(null,P.map(function(x){return x.p})),t0=P[0].t,t1=P[P.length-1].t;
var X=function(t){return pad.l+(t1===t0?0:(t-t0)/(t1-t0))*(W-pad.l-pad.r)},Y=function(p){return pad.t+(mx===mn?.5:(mx-p)/(mx-mn))*(H-pad.t-pad.b)};
var d=P.map(function(x,i){return (i?"L":"M")+X(x.t).toFixed(1)+" "+Y(x.p).toFixed(1)}).join(""),hv=CHT.hover!==null?P[CHT.hover]:null,cur=hv||P[P.length-1],up=chg>=0;
var cc=(cur.p-first)/first,up2=cc>=0;var hero='<div class="chhero"><div class="chp">'+fmtP(cur.p)+'</div><div class="sm"><span class="'+(up2?"ok":"bad")+'">'+(up2?"▲ +":"▼ ")+(cc*100).toFixed(2)+'%</span><span class="mut"> '+(hv?"by "+esc(fmtT(hv.t,CHT.range)):({"1D":"past day","1W":"past week","1M":"past month","1Y":"past year"})[CHT.range])+'</span></div></div>';
var grid=[0,.5,1].map(function(f){var y=pad.t+f*(H-pad.t-pad.b);return '<line x1="'+pad.l+'" x2="'+(W-pad.r)+'" y1="'+y+'" y2="'+y+'" class="chg"/>'}).join("");
var svg='<svg class="chsvg'+(CHT.loading?" ld":"")+'" viewBox="0 0 '+W+' '+H+'" tabindex="0" role="img" aria-label="'+esc(CHT.sym+" price, "+CHT.range+": from "+fmtP(first)+" to "+fmtP(last))+'">'+grid+'<path d="'+d+'" class="chl"/>'+(hv?'<line x1="'+X(hv.t)+'" x2="'+X(hv.t)+'" y1="'+pad.t+'" y2="'+(H-pad.b)+'" class="chx"/><circle cx="'+X(hv.t)+'" cy="'+Y(hv.p)+'" r="4.5" class="chd"/>':'')+'</svg>';
var axis='<div class="chax"><span>'+esc(fmtT(t0,CHT.range))+'</span><span class="mut">High '+fmtP(mx)+' · Low '+fmtP(mn)+'</span><span>'+esc(fmtT(t1,CHT.range))+'</span></div>';
var tbl=CHT.table?'<div class="chtbl"><table><thead><tr><th>Time</th><th>Price</th></tr></thead><tbody>'+P.slice().reverse().map(function(x){return '<tr><td>'+esc(fmtT(x.t,CHT.range))+'</td><td>'+fmtP(x.p)+'</td></tr>'}).join("")+'</tbody></table></div>':'';
CHT.o.querySelector(".aibody").innerHTML=head+hero+rg+'<div class="chbox">'+svg+axis+'</div><div class="chft"><button class="aihand" style="padding:0" data-tbl>'+(CHT.table?"Hide table":"Show as table")+'</button><span class="mut">Prices: DefiLlama</span></div>'+tbl;
var s=CHT.o.querySelector(".chsvg");var pick=function(clientX){var r=s.getBoundingClientRect(),x=(clientX-r.left)/r.width*W,best=0,bd=1e9;P.forEach(function(p,i){var dd=Math.abs(X(p.t)-x);if(dd<bd){bd=dd;best=i}});if(best!==CHT.hover){CHT.hover=best;drawChart()}};
s.addEventListener("pointermove",function(e){pick(e.clientX)});s.addEventListener("pointerleave",function(){CHT.hover=null;drawChart()});
s.addEventListener("keydown",function(e){if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();var i=CHT.hover===null?P.length-1:CHT.hover;CHT.hover=Math.max(0,Math.min(P.length-1,i+(e.key==="ArrowLeft"?-1:1)));drawChart();CHT.o.querySelector(".chsvg").focus()}else if(e.key==="Escape"&&CHT.hover!==null){e.stopPropagation();CHT.hover=null;drawChart()}})}
document.addEventListener("keydown",function(e){if(BK.o&&e.key==="Escape")closeBk()});
var BK={o:null,step:"pw",pw:"",err:null,data:null,shown:false,quiz:null,ans:{},saved:false};
function bkBanner(){var b=S.backup;if(!b||b.done)return "";return '<div class="bkb"><div class="bki"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 8v5M12 16.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></div><div class="bkt"><b>Back up your wallet</b><small>'+(b.kind==="phrase"?"Write down your 12-word recovery phrase. It’s the only way back in if this computer is lost.":"Save your two backup keys. They’re the only way back in if this computer is lost.")+'</small></div><button class="b bkgo" onclick="openBk()">Back up</button></div>'}
function bkLink(){var b=S.backup;if(!b||!b.done)return "";return '<div class="bkl"><button class="aihand" style="padding:0" onclick="openBk()">'+(b.kind==="phrase"?"View recovery phrase":"View backup keys")+'</button></div>'}
function openBk(){BK={o:null,step:"pw",pw:"",err:null,data:null,shown:false,quiz:null,ans:{},saved:false};BK.o=document.createElement("div");BK.o.className="aio";BK.o.innerHTML='<div class="aidlg" role="dialog" aria-modal="true" aria-label="Back up your wallet"><button class="aix" aria-label="Close">×</button><div class="aibody"></div></div>';BK.o.addEventListener("mousedown",function(e){if(e.target===BK.o)closeBk()});BK.o.addEventListener("click",bkClick);document.body.appendChild(BK.o);bkRender();setTimeout(function(){var p=document.getElementById("bkpw");if(p)p.focus()},60)}
function closeBk(){if(BK.o){BK.o.remove()}BK={o:null,step:"pw",pw:"",err:null,data:null,shown:false,quiz:null,ans:{},saved:false}}
function bkWords(){return BK.data&&BK.data.phrase?BK.data.phrase.split(" "):[]}
function bkRender(){if(!BK.o)return;var kind=(S.backup||{}).kind,h="";
if(BK.step==="pw")h='<h2>'+(kind==="phrase"?"Your recovery phrase":"Your backup keys")+'</h2><p class="ailead">'+(kind==="phrase"?"12 words that restore this wallet here, or in MetaMask and Phantom. Anyone who sees them can take your funds, so check no one is looking.":"This wallet was made before recovery phrases, so its backup is two private keys: one for Base, Ethereum, Arbitrum and Polygon, one for Solana. Anyone who sees them can take your funds, so check no one is looking.")+'</p><label class="ailbl" for="bkpw">Wallet password</label><input id="bkpw" class="aiin" type="password" autocomplete="current-password" value="'+esc(BK.pw)+'" oninput="BK.pw=this.value" onkeydown="if(event.key===\'Enter\')bkReveal()">'+(BK.err?'<div class="msg err">'+esc(BK.err)+'</div>':'')+'<button class="b aigoap" onclick="bkReveal()">Show '+(kind==="phrase"?"my recovery phrase":"my backup keys")+'</button>';
else if(BK.step==="show"&&BK.data.kind==="phrase"){var w=bkWords();h='<h2>Write these down</h2><p class="ailead">On paper, in order. Don’t screenshot them or save them in email or notes.</p><div class="bkgrid'+(BK.shown?"":" bkblur")+'">'+w.map(function(x,i){return '<div><span>'+(i+1)+'</span>'+esc(x)+'</div>'}).join("")+(BK.shown?'':'<button class="bkreveal" data-bk="show">Tap to show</button>')+'</div><button class="b aigoap" data-bk="quiz"'+(BK.shown?"":" disabled")+'>I wrote them down</button>'}
else if(BK.step==="show"){var d=BK.data;h='<h2>Save both keys</h2><p class="ailead">Somewhere offline, like a password manager or on paper. Other wallets import them with “Import private key”.</p><div class="bkkey"><small>Base, Ethereum, Arbitrum, Polygon</small><div class="aicmd"><pre id="bk-evm" class="'+(BK.shown?"":"bkblur")+'">'+esc(d.evm_private_key)+'</pre><button class="b g aicp" data-copy="bk-evm">Copy</button></div></div><div class="bkkey"><small>Solana</small><div class="aicmd"><pre id="bk-sol" class="'+(BK.shown?"":"bkblur")+'">'+esc(d.solana_secret_key)+'</pre><button class="b g aicp" data-copy="bk-sol">Copy</button></div></div>'+(BK.shown?'':'<button class="b g aisml" data-bk="show">Show keys</button>')+'<label class="bkchk"><input type="checkbox" '+(BK.saved?"checked":"")+' onchange="BK.saved=this.checked;bkRender()"> I saved both keys somewhere safe</label><button class="b aigoap" data-bk="done"'+(BK.saved?"":" disabled")+'>Done</button>'}
else if(BK.step==="quiz"){var w2=bkWords();h='<h2>Check your copy</h2><p class="ailead">Pick the right word for each number.</p>'+BK.quiz.map(function(q){return '<div class="bkq"><b>Word #'+(q.i+1)+'</b><div class="bkopts">'+q.opts.map(function(o){var st=BK.ans[q.i]===o?(o===w2[q.i]?" ok":" bad"):"";return '<button class="bkopt'+st+'" data-q="'+q.i+'" data-o="'+esc(o)+'">'+esc(o)+'</button>'}).join("")+'</div></div>'}).join("")+(BK.err?'<div class="msg err">'+esc(BK.err)+'</div>':'')+'<div class="btns"><button class="b g" data-bk="back">Show the words again</button><button class="b" data-bk="check">Confirm</button></div>'}
else h='<div class="bkdone">'+svgOk()+'<h2>Backed up</h2><p class="ailead">Keep '+(BK.data&&BK.data.kind==="keys"?"those keys":"those 12 words")+' safe and offline. To restore, run <code>tollkit-wallet restore'+(BK.data&&BK.data.kind==="keys"?" --keys":"")+'</code>'+(BK.data&&BK.data.kind==="phrase"?", or import the phrase into MetaMask or Phantom":"")+'.</p><button class="b aigoap" data-bk="close">Close</button></div>';
BK.o.querySelector(".aibody").innerHTML=h}
function bkReveal(){if(!BK.pw){BK.err="Type your wallet password.";bkRender();return}api("/backup/reveal",{password:BK.pw}).then(function(d){BK.data=d;BK.pw="";BK.err=null;BK.step="show";bkRender()}).catch(function(e){BK.err=e.message;bkRender()})}
function bkQuiz(){var w=bkWords(),idx=[];while(idx.length<3){var r=Math.floor(Math.random()*w.length);if(idx.indexOf(r)<0)idx.push(r)}idx.sort(function(a,b){return a-b});BK.quiz=idx.map(function(i){var o=[w[i]];while(o.length<4){var c=w[Math.floor(Math.random()*w.length)];if(o.indexOf(c)<0)o.push(c)}o.sort(function(){return Math.random()-.5});return {i:i,opts:o}});BK.ans={}}
function bkDone(){api("/backup/done",{}).then(function(){BK.step="done";bkRender();refresh()}).catch(function(e){BK.err=e.message;bkRender()})}
function bkClick(e){var t=e.target.closest("button");if(!t)return;if(t.classList.contains("aix"))return closeBk();var a=t.getAttribute("data-bk");
if(t.hasAttribute("data-copy")){var el=document.getElementById(t.getAttribute("data-copy")),v=el?el.textContent:"",done=function(){t.textContent="Copied";setTimeout(function(){t.textContent="Copy"},1500)};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(done,function(){fallback(v);done()});else{fallback(v);done()}return}
if(t.hasAttribute("data-q")){BK.ans[Number(t.getAttribute("data-q"))]=t.getAttribute("data-o");BK.err=null;bkRender();return}
if(a==="show"){BK.shown=true;bkRender()}else if(a==="quiz"){bkQuiz();BK.step="quiz";BK.err=null;bkRender()}else if(a==="back"){BK.step="show";bkRender()}
else if(a==="check"){var w=bkWords();if(BK.quiz.every(function(q){return BK.ans[q.i]===w[q.i]}))bkDone();else{BK.err="Not quite. Check your copy against the words and try again.";bkRender()}}
else if(a==="done")bkDone();else if(a==="close")closeBk()}
var LASTAP=null,CH={seen:null,n:-1,top:null,draft:"",pw:"",err:null,sending:false,manual:false},CHIPS=["Protect my ETH if the price drops hard","Buy SOL on dips, about $20 at a time","Set up a weekly buy I can stick with","How are my rules doing?"];
function fmtAi(t){var B=/^\s*([-•*]|\d+\.)\s+/,h=esc(t).replace(/\*\*([^*]+)\*\*/g,"<b>$1</b>").replace(/\x60([^\x60]+)\x60/g,"<code>$1</code>");return h.split(/\n{2,}/).map(function(p){var out="",ul=[],tx=[];function fT(){if(tx.length){out+='<p>'+tx.join("<br>")+'</p>';tx=[]}}function fU(){if(ul.length){out+='<ul>'+ul.map(function(l){return '<li>'+l+'</li>'}).join("")+'</ul>';ul=[]}}p.split("\n").forEach(function(l){if(B.test(l)){fT();ul.push(l.replace(B,""))}else{fU();tx.push(l)}});fT();fU();return out}).join("")}
function tm(ts){var d=new Date(ts);return d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})+(Date.now()-d>864e5?" · "+d.toLocaleDateString([],{month:"short",day:"numeric"}):"")}
function aiName(){var A=S.ai||{};return A.provider?A.provider.name:"AI"}
function ckey(m){return m.role==="you"?"y:"+m.text:(m.id||m.ts)}
function chatMsg(m,last){var nw=CH.seen&&!CH.seen[ckey(m)]?" tc-new":"";if(m.role==="you")return '<div class="tc-cm tc-you'+nw+'"><div class="tc-cb">'+esc(m.text).replace(/\n/g,"<br>")+'</div></div>';
if(m.checkin&&m.quiet&&!m.error)return '<div class="tc-cq">'+svgClock()+'Check-in '+tm(m.ts)+' · '+esc(m.text.replace(/^No changes[.:,]?\s*/i,"No changes. "))+'</div>';
var cards=(m.rules||[]).map(function(id){var r=(S.rules||[]).filter(function(x){return x.id===id})[0];return r?ruleCard(r):""}).join("");
return '<div class="tc-cm tc-ai'+nw+(m.error?" tc-err":"")+'"><div class="tc-cav">'+aiSvg("claude")+'</div><div class="tc-cbw">'+(m.checkin?'<div class="tc-ctag">Check-in · '+tm(m.ts)+'</div>':'')+'<div class="tc-cb">'+fmtAi(m.text)+'</div>'+(cards?'<div class="tc-ccards">'+cards+'</div>':'')+(m.error&&last&&m.fuel&&!(S.ai||{}).busy?fuelBox(m):'')+'</div></div>'}
function fuelBox(m){var f=m.fuel;return '<div class="tc-fuel"><button class="b ok" onclick="topUp(\''+esc(m.id)+'\')">Swap $'+f.usd+' of '+esc(f.sell)+' to USDC and send</button><label class="tc-fchk"><input type="checkbox" id="fuelauto">Top up automatically from now on</label><div class="sm mut">That’s about '+Math.floor(f.usd/0.02)+' steps. Tollkit’s 0.5% fee is about $'+(f.usd*0.005).toFixed(2)+', and your trading limits apply. Or <a href="#" onclick="openAI();return false">connect your own Claude or ChatGPT</a> for free.</div></div>'}
function topUp(id){var cb=document.getElementById("fuelauto"),auto=!!(cb&&cb.checked);CH.sending=true;CH.err=null;render();api("/ai/topup",{id:id,auto:auto}).then(function(){return refresh()}).catch(function(e){CH.err=e.message}).then(function(){CH.sending=false;render()})}
function fuelRow(){var f=S.ai.fuel.mode;return '<div class="row"><div style="min-width:0"><div>Paying for Claude</div><div class="sm mut">$0.02 a step, in USDC. '+(f==="auto"?"When USDC runs low, the wallet swaps $2 of SOL or ETH to USDC on its own.":"The chat asks before swapping SOL or ETH to USDC.")+'</div></div><div class="r"><div class="bseg tmseg"><button class="bsb'+(f==="ask"?" on":"")+'" onclick="setFuel(\'ask\')">Ask</button><button class="bsb'+(f==="auto"?" on":"")+'" onclick="setFuel(\'auto\')">Auto</button></div></div></div>'}
function setFuel(m){api("/ai/fuel",{mode:m}).then(function(){flash=[1,m==="auto"?"Claude tops up its USDC on its own from now on.":"Claude will ask before topping up."];return refresh()}).catch(function(e){flash=[0,e.message];render()})}
function svgClock(){return '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'}
function chatBox(){var A=S.ai;if(!A)return "";var M=A.messages||[],busy=A.busy||CH.sending;
var head='<div class="tc-chd"><div class="tc-chn">'+aiSvg("claude")+'<div><b>'+esc(aiName())+'</b><small>'+(busy?'<span class="ok">Working…</span>':A.provider?esc(A.provider.note||'Your Claude, on this computer'):'Not set up')+'</small></div></div>'+
'<div class="tc-chr"><label class="tc-chk" title="Let the AI review your rules on a schedule">'+svgClock()+'<select onchange="setCheckin(this.value)">'+[[0,"Check-ins off"],[1,"Every hour"],[4,"Every 4 hours"],[12,"Every 12 hours"],[24,"Daily"]].map(function(o){return '<option value="'+o[0]+'"'+(A.checkin.every_hours===o[0]?" selected":"")+'>'+o[1]+'</option>'}).join("")+'</select></label>'+(M.length?'<button class="b g tc-chx'+(CH.confirmNew?" tc-warn":"")+'" onclick="newChat()" title="Start over. Your rules stay on.">'+(CH.confirmNew?'Clear chat?':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z M14 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>New chat')+'</button>':'')+'</div></div>';
if(!A.provider)return '<div class="tc-chat">'+head+'<div class="tc-cempty"><b>Chat with your AI here</b><p>Install <b>Claude Code</b> on this computer and sign in once (run <code>claude</code> in Terminal). Then reopen this page. It uses your own Claude plan; the wallet never sees your Claude login.</p></div></div>';
var body=M.length?M.map(function(m,i){return chatMsg(m,i===M.length-1)}).join(""):'<div class="tc-cempty"><b>What do you want your autopilot to do?</b><p>Say it in your own words. '+esc(aiName())+' checks prices and your balances, then suggests rules you can turn on with one tap.</p>'+(tkClaude()?'<p class="tc-own">Have Claude or ChatGPT already? <a href="#" onclick="openAI();return false">Connect it for free</a> and chat there instead.</p>':'')+'<div class="tc-cchips">'+CHIPS.map(function(c,i){return '<button class="tc-cchip" onclick="chatSend(CHIPS['+i+'])">'+esc(c)+'</button>'}).join("")+'</div></div>';
if(busy)body+='<div class="tc-cm tc-ai"><div class="tc-cav">'+aiSvg("claude")+'</div><div class="tc-cbw"><div class="tc-cb tc-ctyping"><i></i><i></i><i></i><span>'+(A.busy&&A.busy.note?esc(A.busy.note):A.busy&&A.busy.kind==="checkin"?"Checking in on your rules…":"Looking at prices and your wallet…")+'</span></div></div></div>';
var pw=!A.ready?'<div class="tc-cpw"><div class="sm">One time: your wallet password lets '+esc(aiName())+' read your balances. It’s saved on this computer, readable only by your account.</div><div class="tc-crow"><input id="chpw" type="password" placeholder="Wallet password" value="'+esc(CH.pw)+'" oninput="CH.pw=this.value"><button class="b" onclick="chatPw()">Save</button></div></div>':"";
var inp='<div class="tc-cin"><textarea id="chin" rows="1" placeholder="Message '+esc(aiName())+'…" oninput="CH.draft=this.value;grow(this)" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();chatSend()}"'+(A.ready?"":" disabled")+'>'+esc(CH.draft)+'</textarea><button class="b tc-csend" onclick="chatSend()"'+(busy||!A.ready?" disabled":"")+' aria-label="Send"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>';
return '<div class="tc-chat">'+head+'<div class="tc-cbody" id="cbody">'+body+'</div>'+(CH.err?'<div class="msg tc-err" style="margin:0 12px 10px">'+esc(CH.err)+'</div>':'')+pw+inp+'</div>'}
function grow(t){t.style.height="auto";t.style.height=Math.min(140,t.scrollHeight)+"px"}
function chatAfter(){var b=document.getElementById("cbody");if(!b)return;CH.seen=CH.seen||{};((S.ai||{}).messages||[]).forEach(function(m){CH.seen[ckey(m)]=1});var n=((S.ai||{}).messages||[]).length+((S.ai||{}).busy||CH.sending?1:0);if(n!==CH.n||CH.top===null){var ms=b.querySelectorAll(".tc-cm"),last=ms[ms.length-1];b.style.scrollBehavior="auto";b.scrollTop=last&&last.offsetHeight>b.clientHeight-16?last.offsetTop-8:b.scrollHeight;b.style.scrollBehavior=""}else b.scrollTop=CH.top;CH.n=n;b.onscroll=function(){CH.top=b.scrollTop};var t=document.getElementById("chin");if(t){grow(t);if(CH.refocus!==undefined&&CH.refocus!==null){t.focus();try{t.setSelectionRange(CH.refocus,CH.refocus)}catch(e){}CH.refocus=null}}}
function chatSend(text){var t=(text!==undefined?text:CH.draft).trim();if(!t||CH.sending)return;CH.sending=true;CH.err=null;if(text===undefined)CH.draft="";S.ai.messages=(S.ai.messages||[]).concat([{role:"you",text:t,ts:new Date().toISOString()}]);render();
api("/ai/chat",{text:t}).then(function(){return refresh()}).catch(function(e){CH.err=e.message;if(text===undefined)CH.draft=t}).then(function(){CH.sending=false;render()})}
function chatPw(){api("/ai/password",{password:CH.pw}).then(function(){CH.pw="";CH.err=null;return refresh()}).catch(function(e){CH.err=e.message;render()})}
function setCheckin(h){api("/ai/checkin",{hours:Number(h)}).then(function(){flash=[1,Number(h)?"Check-ins on. "+aiName()+" will review your rules and suggest changes for you to approve.":"Check-ins off."];refresh()}).catch(function(e){flash=[0,e.message];render()})}
function newChat(){if(!CH.confirmNew){CH.confirmNew=true;LASTAP=null;render();clearTimeout(CH.cnT);CH.cnT=setTimeout(function(){CH.confirmNew=false;LASTAP=null;render()},4000);return}
clearTimeout(CH.cnT);CH.confirmNew=false;api("/ai/new",{}).then(function(){CH.n=-1;CH.top=null;flash=[1,"New chat started. Your rules are unchanged."];return refresh()}).catch(function(e){flash=[0,e.message];render()})}
function tokIcon(sym,chain,logo){var k=String(sym||"").toUpperCase();if(k==="WETH")k="ETH";if(k==="WPOL")k="POL";var svg=COIN.coin[k];return '<div class="ic tok">'+(svg||(logo&&logo.indexOf("https:")===0?'<img class="tlogo" src="'+esc(logo)+'" alt="" loading="lazy" referrerpolicy="no-referrer" data-tl="'+esc(k.slice(0,4))+'">':'<span class="tl">'+esc(k.slice(0,4))+'</span>'))+(chain&&COIN.chain[chain]?'<span class="cb">'+COIN.chain[chain]+'</span>':"")+'</div>'}
function chainIcon(chain,extra){return '<div class="ic tok">'+(COIN.chain[chain]||esc(String(chain||"?")[0].toUpperCase()))+(extra&&COIN.chain[extra]?'<span class="cb">'+COIN.chain[extra]+'</span>':"")+'</div>'}
function kindIcon(e){if(e.kind==="stake")return tokIcon("SOL","solana");var m=/^[\d.,]+ ([A-Za-z]+)/.exec(e.detail||"");if(e.kind!=="payment"&&m)return tokIcon(m[1],e.chain);return '<div class="ic tok"><span class="glyph">'+(e.kind==="payment"?"P":e.kind==="trade"?"S":"W")+'</span>'+(COIN.chain[e.chain]?'<span class="cb">'+COIN.chain[e.chain]+'</span>':"")+'</div>'}
function amt(x){var n=Number(x);return isFinite(n)?n.toLocaleString(undefined,{maximumFractionDigits:6}):String(x)}
var NAMES={ETH:"Ethereum",WETH:"Wrapped Ether",USDC:"USD Coin",USDT:"Tether",SOL:"Solana"},CHAIN_NAMES={base:"Base",ethereum:"Ethereum",arbitrum:"Arbitrum",polygon:"Polygon",solana:"Solana"},prevVal={};
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
(S.trade_mode==="python"?pyCard():"")+botsHtml()+(S.ai?'<h3>Ask Claude</h3>':'')+
chatBox()+
(prop.length?'<h3>Waiting for you</h3>'+prop.map(ruleCard).join(""):"")+
'<h3>Your rules</h3>'+(act.length?act.map(ruleCard).join(""):'<div class="mut sm">No rules on yet.</div>')+
(hist.length?'<h3>History</h3>'+hist.map(ruleCard).join(""):"")+
'<details class="mrule"'+(manualOpen?" open":"")+' ontoggle="CH.manual=this.open"><summary>Write a rule yourself</summary><textarea id="stxt" rows="3" placeholder="e.g. Buy $25 of SOL every Monday. Sell half my ETH if it rises 10% and all if it falls 8%." style="width:100%;margin-top:8px;background:var(--surf);border:1px solid var(--line);color:var(--tx);border-radius:10px;padding:10px;font:inherit;resize:vertical"></textarea>'+
'<div class="toggles" style="margin-top:6px">'+TEMPL.map(function(t,i){return '<button class="chip" style="border:0;cursor:pointer" onclick="document.getElementById(\'stxt\').value=TEMPL['+i+']">'+esc(t)+'</button>'}).join("")+'</div>'+
'<div style="margin-top:10px"><button class="b" onclick="preview()">Preview</button></div>'+pv+'</details>'}
// ---- Bots: rule-based (no AI) bots, their status and results, and Tollkit's public board ----
var BOT={open:null,tpl:null,anim:false,flash:null,chain:"base",token:"ETH",params:{},pv:null,err:null,busy:false,more:{}};
function botPill(st){var m={running:["ok","Running"],waiting:["","Waiting for its price"],paused:["warn","Paused"],error:["bad","Stopped by errors"],done:["","Finished"],stopped:["","Stopped"]}[st]||["",st];return '<span class="chip botpill '+m[0]+'">'+m[1]+'</span>'}
function money(n){return (n<0?"−":"")+fmtUsd(Math.abs(n))}
function botCard(b){var res=b.result_usd!==null?'<span class="'+(b.result_usd>=0?"ok":"bad")+'">'+(b.result_usd>=0?"+":"")+money(b.result_usd)+(b.result_pct!==null?' ('+(b.result_pct>=0?"+":"")+b.result_pct+'%)':'')+'</span>':'<span class="mut">—</span>';
var live=b.status==="running"||b.status==="waiting"||b.status==="error",open=BOT.more[b.id];
return '<div class="botc'+(BOT.flash===b.id?" botflash":"")+'" data-botcard="'+esc(b.id)+'"><div class="botct"><div style="min-width:0"><b>'+esc(b.name)+'</b><div class="sm mut">'+esc(CHAIN_NAMES[b.chain]||b.chain)+(b.last_trade?' · last trade '+ago(b.last_trade):' · no trades yet')+'</div></div>'+botPill(b.status)+'</div>'+
'<div class="botstats"><div><small>Trades</small><b>'+b.trades_ok+'</b></div><div><small>Failed</small><b class="'+(b.trades_failed?"bad":"")+'">'+b.trades_failed+'</b></div><div><small>Success</small><b>'+(b.success_rate===null?"—":b.success_rate+"%")+'</b></div><div><small>Result</small><b>'+res+'</b></div></div>'+
(b.round_trips?'<div class="sm mut" style="margin-top:6px">'+b.round_trips+' buy-and-sell round trip'+(b.round_trips>1?"s":"")+' done</div>':'')+
'<div class="btns" style="margin-top:8px"><button class="b g" data-botmore="'+esc(b.id)+'">'+(open?"Hide":"Details")+'</button>'+(b.status==="paused"?'<button class="b ok" data-botst="active" data-bot="'+esc(b.id)+'">Resume</button>':live?'<button class="b g" data-botst="paused" data-bot="'+esc(b.id)+'">Pause</button>':'')+(b.status!=="done"&&b.status!=="stopped"?'<button class="b no" data-botst="cancelled" data-bot="'+esc(b.id)+'">Stop</button>':'')+'</div>'+
(open?'<div class="sm" style="margin-top:8px">'+b.rules.map(function(r){return '<div style="margin:4px 0">• '+esc(r.description)+' <span class="mut">('+esc(r.status)+')</span>'+(r.last_error?'<div class="bad">'+esc(r.last_error)+'</div>':'')+'</div>'}).join("")+'<div class="mut" style="margin-top:4px">Spent '+fmtUsd(b.spent_usd)+' · received '+fmtUsd(b.received_usd)+(b.value_now_usd!==null&&b.units_held?' · holding about '+fmtUsd(b.value_now_usd):'')+'</div></div>':'')+'</div>'}
function boardFor(id){var B=S.bot_board;if(!B||!B.templates)return null;for(var i=0;i<B.templates.length;i++)if(B.templates[i].template===id)return B.templates[i];return null}
function boardLine(id){var x=boardFor(id);if(!x||x.bots<3)return '<div class="sm mut">Not enough shared results yet.</div>';return '<div class="sm mut">'+x.bots+' bots shared · median result '+(x.median_result_pct>=0?"+":"")+x.median_result_pct+'% · '+x.success_rate+'% of trades went through</div>'}
function botsHtml(){var L=S.bots||[],T=S.bot_templates||[];
var h='<h3>Your bots</h3>'+(L.length?L.map(botCard).join(""):'<div class="mut sm">No bots yet. Start one below; it follows your limits like any trade.</div>');
h+='<h3>Start a bot</h3><div class="sm mut" style="margin-bottom:6px">Plain rules, no AI. You see every step before it starts.</div><div class="botcat">'+T.map(function(t){var on=BOT.tpl===t.id;return tplCard(t,on,L)+(on?'<div class="botwrap'+(BOT.anim?" drop":"")+'"><div class="botin">'+botForm()+'</div></div>':'')}).join("")+'</div>';
BOT.anim=false;
h+='<label class="botshare"><input type="checkbox" id="botshare"'+(S.bot_share?" checked":"")+' onchange="botShare(this.checked)"> Share my bots’ results with Tollkit’s public bot board (anonymous: bot type, token, trade counts and result %, no addresses or amounts)</label>';
return h}
var ARROW='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
function tplCard(t,on,L){var mine=L.filter(function(b){return b.template===t.id}),live=mine.filter(function(b){return b.status!=="done"&&b.status!=="stopped"});
var head='<div class="tplh"><b>'+esc(t.name)+'</b>'+(live.length===1?botPill(live[0].status):live.length>1?'<span class="chip botpill ok">'+live.length+' bots</span>':'')+'</div>';
if(!live.length){var past=mine.length?'<div class="sm mut">Your last one: '+esc(({done:"finished",stopped:"stopped"})[mine[0].status]||mine[0].status)+'.</div>':'';
return '<button class="bottpl'+(on?" on":"")+'" data-tpl="'+esc(t.id)+'" aria-expanded="'+on+'">'+head+'<small>'+esc(t.blurb)+'</small>'+boardLine(t.id)+past+'<span class="botcta">'+(on?'Close setup':(mine.length?'Set up again':'Set up '+esc(t.name)+' bot')+ARROW)+'</span></button>'}
var b=live[0],line;if(live.length===1){var res=b.result_usd!==null?' · <span class="'+(b.result_usd>=0?"ok":"bad")+'">'+(b.result_usd>=0?"+":"")+money(b.result_usd)+'</span>':'';line=esc(b.token)+' on '+esc(CHAIN_NAMES[b.chain]||b.chain)+' · '+b.trades_ok+' trade'+(b.trades_ok===1?"":"s")+(b.trades_failed?' · <span class="bad">'+b.trades_failed+' failed</span>':'')+res+(b.last_trade?' · last '+ago(b.last_trade):'')}
else{var c={};live.forEach(function(x){c[x.status]=(c[x.status]||0)+1});line=Object.keys(c).map(function(k){return c[k]+' '+({running:"running",waiting:"waiting for a price",paused:"paused",error:"stopped by errors"})[k]}).join(" · ")}
return '<div class="bottpl has'+(on?" on":"")+(live.some(function(x){return x.status==="error"})?" err":"")+'">'+head+'<div class="sm">'+line+'</div>'+boardLine(t.id)+'<div class="tplbtns"><button class="botcta" data-botview="'+esc(b.id)+'">'+(live.length>1?'View bots':'View bot')+ARROW+'</button><button class="botcta g" data-tpl="'+esc(t.id)+'" aria-expanded="'+on+'">'+(on?'Close setup':'+ Set up another')+'</button></div></div>'}
function botForm(){var t=(S.bot_templates||[]).filter(function(x){return x.id===BOT.tpl})[0];if(!t)return "";
var f=t.fields.map(function(x){var v=BOT.params[x.key]!==undefined?BOT.params[x.key]:x.default;if(x.kind==="choice")return '<label class="botf"><span>'+esc(x.label)+'</span><select data-bp="'+esc(x.key)+'">'+x.choices.map(function(c){return '<option value="'+esc(c[0])+'"'+(String(v)===c[0]?" selected":"")+'>'+esc(c[1])+'</option>'}).join("")+'</select></label>';var lim=x.kind==="pct"&&x.max!==undefined?' <em class="botlim">up to '+Number(x.max).toLocaleString()+'%</em>':'';return '<label class="botf"><span>'+esc(x.label)+lim+'</span><input type="number" step="any" inputmode="decimal" data-bp="'+esc(x.key)+'"'+(x.min!==undefined?' min="'+x.min+'"':'')+(x.max!==undefined?' max="'+x.max+'"':'')+' value="'+esc(String(v))+'"></label>'}).join("");
return '<div class="ap botform" style="white-space:normal"><b>'+esc(t.name)+'</b><div class="sm mut" style="margin:4px 0 8px">Risk: '+esc(t.risk)+'</div><div class="botgrid"><label class="botf"><span>Network</span><select id="bot_chain">'+ALLCH.map(function(c){return [c,CHAIN_NAMES[c]]}).map(function(o){return '<option value="'+o[0]+'"'+(BOT.chain===o[0]?" selected":"")+'>'+o[1]+'</option>'}).join("")+'</select></label><label class="botf"><span>Token (symbol or address)</span><input id="bot_token" value="'+esc(BOT.token)+'" autocomplete="off" spellcheck="false"></label>'+f+'</div>'+
(BOT.err?'<div class="msg err">'+esc(BOT.err)+'</div>':'')+(BOT.pv?'<div class="sm" style="margin-top:8px"><div class="mut">'+(BOT.pv.price?'Today’s price about $'+Number(BOT.pv.price).toLocaleString(undefined,{maximumSignificantDigits:6})+'. ':'')+'It will:</div>'+BOT.pv.rules.map(function(r){return '<div style="margin:4px 0">• '+esc(r.description)+'</div>'}).join("")+'</div>':'')+
'<div class="btns"><button class="b g" onclick="botClose()">Cancel</button>'+(BOT.pv?'<button class="b ok" onclick="botGo(\'start\')"'+(BOT.busy?" disabled":"")+'>Start bot</button>':'<button class="b" onclick="botGo(\'preview\')"'+(BOT.busy?" disabled":"")+'>Preview</button>')+'</div></div>'}
function botRead(){var c=document.getElementById("bot_chain"),t=document.getElementById("bot_token");if(c)BOT.chain=c.value;if(t)BOT.token=t.value.trim();document.querySelectorAll("[data-bp]").forEach(function(el){BOT.params[el.getAttribute("data-bp")]=el.tagName==="SELECT"?el.value:Number(el.value)})}
function botGo(what){botRead();BOT.busy=true;BOT.err=null;render();api("/bots/"+what,{template:BOT.tpl,chain:BOT.chain,token:BOT.token,params:BOT.params}).then(function(r){BOT.busy=false;if(what==="preview"){BOT.pv=r;render()}else{BOT.tpl=null;BOT.pv=null;flash=[1,"Bot started. It shows under Your bots."];refresh().then(function(){render()})}}).catch(function(e){BOT.busy=false;BOT.err=e.message;render()})}
function botClose(){var w=document.querySelector(".botwrap");BOT.pv=null;BOT.err=null;var done=function(){BOT.tpl=null;render()};if(!w||(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches)){done();return}w.classList.remove("drop");w.classList.add("closing");setTimeout(done,240)}
function botShare(on){api("/bots/share",{on:on}).then(function(){refresh()}).catch(function(e){flash=[0,e.message];render()})}
document.addEventListener("click",function(e){var t=e.target.closest&&e.target.closest("[data-tpl],[data-botst],[data-botmore],[data-botview]");if(!t)return;
if(t.hasAttribute("data-botview")){var vid=t.getAttribute("data-botview");BOT.more[vid]=true;BOT.flash=vid;render();var card=document.querySelector('[data-botcard="'+vid+'"]');if(card&&card.scrollIntoView)card.scrollIntoView({behavior:RM?"auto":"smooth",block:"center"});setTimeout(function(){if(BOT.flash===vid){BOT.flash=null;var c2=document.querySelector('[data-botcard="'+vid+'"]');if(c2)c2.classList.remove("botflash")}},1600);return}
if(t.hasAttribute("data-tpl")){var id=t.getAttribute("data-tpl");if(BOT.tpl===id){botClose();return}BOT.tpl=id;BOT.anim=true;BOT.params={};BOT.pv=null;BOT.err=null;if((BOT.token==="ETH"||BOT.token==="SOL"||BOT.token==="POL")&&NATIVE[BOT.chain])BOT.token=NATIVE[BOT.chain];render();setTimeout(function(){var w=document.querySelector(".botwrap");if(!w)return;w.classList.remove("drop");if(w.scrollIntoView)w.scrollIntoView({behavior:"smooth",block:"nearest"})},460);return}
if(t.hasAttribute("data-botmore")){var k=t.getAttribute("data-botmore");BOT.more[k]=!BOT.more[k];render();return}
var st=t.getAttribute("data-botst"),bid=t.getAttribute("data-bot");api("/bots/status",{bot:bid,status:st}).then(function(){flash=[1,st==="paused"?"Paused.":st==="active"?"Resumed.":"Stopped."];refresh().then(function(){render()})}).catch(function(e){flash=[0,e.message];render()})});
document.addEventListener("input",function(e){var t=e.target;if(!t||!t.hasAttribute||!t.hasAttribute("data-bp")||t.tagName!=="INPUT"||t.value==="")return;var mx=t.getAttribute("max");if(mx!==null&&Number(t.value)>Number(mx)){t.value=mx;t.classList.remove("botcap");void t.offsetWidth;t.classList.add("botcap")}});
document.addEventListener("focusout",function(e){var t=e.target;if(!t||!t.hasAttribute||!t.hasAttribute("data-bp")||t.tagName!=="INPUT")return;var mn=t.getAttribute("min");if(mn!==null&&(t.value===""||Number(t.value)<Number(mn)))t.value=mn});
document.addEventListener("change",function(e){if(e.target&&e.target.id==="bot_chain"){BOT.chain=e.target.value;var ti=document.getElementById("bot_token");if(ti&&(ti.value==="ETH"||ti.value==="SOL"||ti.value==="POL")){ti.value=NATIVE[BOT.chain]||"ETH";BOT.token=ti.value}BOT.pv=null}else if(e.target&&(e.target.id==="bot_token"||e.target.hasAttribute&&e.target.hasAttribute("data-bp")))BOT.pv=null});
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
function rowUsd(e){if(Number(e.usd)>0)return usd(e.usd);var m=(e.kind==="stake"?/([\d.]+) (SOL)/:/^([\d.]+) ([A-Za-z]+)/).exec(e.detail||""),p=m&&priceOf(m[2]==="WETH"?"ETH":m[2]);return p&&p.usd?'<span title="at today\'s price">≈'+usd(Number(m[1])*p.usd)+'</span>':usd(e.usd)}
function usd(n){n=Number(n)||0;return "$"+n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:n<1&&n>0?4:2})}
function ago(ts){var s=(Date.now()-Date.parse(ts))/1000;if(s<60)return "just now";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return new Date(ts).toLocaleDateString()}
var ICONS={autopilot:'<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',home:'<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',activity:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',approvals:'<path d="M5 13l4 4L19 7"/>',settings:'<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',withdraw:'<path d="M12 4v12m0 0l-5-5m5 5l5-5M5 20h14"/>'};
var TABS=["home","activity","autopilot","approvals","settings","withdraw"];
function nav(){var el=document.getElementById("nav");if(!el.querySelector("button")){el.innerHTML='<div class="ind" id="ind"></div>'+TABS.map(function(k){return '<button data-k="'+k+'" onclick="go(\''+k+'\')">'+(k==="autopilot"?'<span class="emo" aria-hidden="true">\u{1F916}</span>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+ICONS[k]+'</svg>')+(k==="autopilot"?"Bots":k[0].toUpperCase()+k.slice(1))+'</button>'}).join("")}
el.querySelectorAll("button").forEach(function(b){b.classList.toggle("on",b.getAttribute("data-k")===tab)});
document.getElementById("ind").style.transform="translateX("+(TABS.indexOf(tab)*100)+"%)";
navMark(el)}
// Why a tab is worth a tap. Activity and Home only count what's new since this page opened (or since you last looked).
var SEEN=null;
function navSeen(k){if(!S||!SEEN)return;if(k==="activity")(S.receipts||[]).forEach(function(r){SEEN.rc[r.id]=r.status});if(k==="home"&&S.live)S.live.events.forEach(function(e){SEEN.ev[e.id]=1})}
function navWhy(){var w={};if(!S)return w;
if(!SEEN){SEEN={rc:{},ev:{}};navSeen("activity");navSeen("home")}
if(tab==="activity"||tab==="home")navSeen(tab);
var np=(S.pending||[]).length;if(np)w.approvals={n:np,lvl:"bad",t:np+(np>1?" requests are":" request is")+" waiting for your OK"};
var prop=(S.rules||[]).filter(function(r){return r.status==="proposed"}).length,berr=(S.bots||[]).filter(function(b){return b.status==="error"}).length;
if(prop||berr)w.autopilot={n:prop+berr,lvl:berr?"bad":"acc",t:[prop?prop+" suggested rule"+(prop>1?"s":"")+" to review":"",berr?berr+" bot"+(berr>1?"s":"")+" stopped by errors":""].filter(Boolean).join(" · ")};
var bk=S.backup;if(bk&&!bk.done)w.settings={lvl:"warn",t:"Your wallet isn't backed up yet"};
var nr=0,nf=0;(S.receipts||[]).forEach(function(r){var was=SEEN.rc[r.id];if(was===undefined||(r.status==="failed"&&was!=="failed")){nr++;if(r.status==="failed")nf++}});
if(nr)w.activity={n:nr,lvl:nf?"bad":"acc",t:nr+" new in Activity"+(nf?" ("+nf+" failed)":"")};
var nd=S.live?S.live.events.filter(function(e){return e.direction==="in"&&!SEEN.ev[e.id]}).length:0;
if(nd)w.home={n:nd,lvl:"ok",t:nd+" new deposit"+(nd>1?"s":"")};
return w}
function navMark(el){var w=navWhy();el.querySelectorAll("button").forEach(function(b){var k=b.getAttribute("data-k"),r=w[k],name=k==="autopilot"?"Bots":k[0].toUpperCase()+k.slice(1);
var key=r?r.lvl+"|"+(r.n||"")+"|"+r.t:"";if(b.getAttribute("data-why")===key)return;b.setAttribute("data-why",key);
b.classList.remove("attn","attn-bad","attn-warn","attn-ok","attn-acc");var old=b.querySelector(".badge");if(old)old.remove();
b.title=r?r.t:"";b.setAttribute("aria-label",r?name+": "+r.t:name);if(!r)return;
b.classList.add("attn","attn-"+r.lvl);var sp=document.createElement("span");sp.className="badge"+(r.n?"":" dot");sp.textContent=r.n?(r.n>99?"99+":String(r.n)):"";b.appendChild(sp)})}
function go(k){if(k===tab&&!flash)return;var changed=k!==tab;tab=k;flash=null;render(true);if(changed){var mm=document.getElementById("main");if(mm)mm.scrollTop=0}}
function msg(){return flash?'<div class="msg '+(flash[0]?"okk":"err")+'">'+esc(flash[1])+'</div>':""}
function render(enter){nav();if(!S)return;if(PYO)pyRender();var a=S.approvals||"none";var ap=document.getElementById("appr");ap.classList.toggle("live",a!=="none"||!!S.live);ap.textContent=(S.live?"Live":"")+(S.live?" · ":"")+(a==="none"?"Approvals off":"Approvals on");ap.title=a==="none"?"Set up Telegram or keep this page open":"Answered via "+a.replace("+"," and ");ap.onclick=function(){go("settings")};ap.style.cursor="pointer";var m=document.getElementById("main");
if(tab!=="autopilot")LASTAP=null;if(tab!=="settings"){LIMD={};LIMPW=""}var prevTab=m.dataset.tab;m.dataset.tab=tab;if(tab==="home")m.innerHTML=home();else if(tab==="activity")m.innerHTML=activity();else if(tab==="approvals")m.innerHTML=approvals();else if(tab==="settings")m.innerHTML=settings();else if(tab==="autopilot"){var h=autopilot();if(!enter&&h===LASTAP&&prevTab==="autopilot"){chatAfter();return}m.innerHTML=h;LASTAP=h;chatAfter()}else{m.innerHTML=withdraw();tokOpts()}
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
rows+='<div class="row'+rowAttrs(coinOf(c,t.token),t.token,c,NAMES[t.token]||t.token)+'>'+tokIcon(t.token,c)+'<div style="min-width:0"><div class="tname">'+esc(NAMES[t.token]||t.token)+'</div><div class="sm">'+(pr&&pr.change_24h!==null&&!/^USD/.test(t.token)?'<span class="'+(pr.change_24h>=0?"ok":"bad")+'">'+(pr.change_24h>=0?"+":"")+(pr.change_24h*100).toFixed(2)+'%</span><span class="mut"> · '+esc(CHAIN_NAMES[c]||c)+'</span>':'<span class="mut">'+esc(CHAIN_NAMES[c]||c)+'</span>')+'</div></div><div class="r"><div class="usdv'+dir+'">'+(val===null?"—":fmtUsd(val))+'</div><div class="sm mut">'+esc(fmtAmt(a))+' '+esc(t.token)+'</div></div></div>'})})}
var p=S.policy,sp=S.spent_today;function lim(lbl,used,max){return '<div class="row" style="display:block"><div style="display:flex"><span>'+lbl+'</span><span class="r mut">'+usd(used)+' of '+usd(max)+'</span></div><div class="bar"><i data-w="'+Math.min(100,used/max*100).toFixed(2)+'"></i></div></div>'}
var HR=holdRows();rows+=HR.rows;tot+=HR.tot;chg+=HR.chg;var chgPct=tot-chg>0?chg/(tot-chg):0;
return '<div class="mut sm">Total balance</div><div class="big">'+(BL?'<span id="tot" data-v="'+tot+'">'+fmtUsd(shown===null?0:shown)+'</span>':'<span class="skel"></span>')+'</div><div class="sm daychg">'+(BL&&S.prices&&S.prices.at?'<span class="'+(chg>=0?"ok":"bad")+'">'+(Math.abs(chg)<0.01?(chg>=0?"+":"−")+"$0.00":(chg>=0?"+":"−")+fmtUsd(Math.abs(chg)))+' ('+(chg>=0?"+":"")+(chgPct*100).toFixed(2)+'%)</span><span class="mut"> today</span>':'<span class="mut">Prices loading…</span>')+'</div>'+
walletActions()+bkBanner()+aiBtn()+liveSection()+'<h3>Today</h3>'+lim("Trades",sp.trades_usd,p.daily_trades_usd)+lim("Payments",sp.payments_usd,p.daily_payments_usd)+
'<h3>Balances</h3>'+(rows||'<div class="mut">Loading…</div>')+holdFoot()+
'<h3>Deposit addresses</h3><div class="row">'+chainIcon("base","ethereum")+'<div><div class="sm mut">'+EVMNAMES+'</div><div class="addr" title="'+esc(S.addresses.evm)+'">'+esc(short(S.addresses.evm))+'</div></div>'+cpBtn(S.addresses.evm)+'</div><div class="row">'+chainIcon("solana")+'<div><div class="sm mut">Solana</div><div class="addr" title="'+esc(S.addresses.solana)+'">'+esc(short(S.addresses.solana))+'</div></div>'+cpBtn(S.addresses.solana)+'</div>'+bkLink()}
function activity(){var r=S.receipts;if(!r.length)return '<div class="empty">No trades or payments yet.</div>';return '<div style="display:flex;align-items:center"><h3 style="margin:0">Activity</h3><a class="sm" style="margin-left:auto" href="/api/receipts.csv?t='+T+'">Export CSV</a></div>'+r.map(function(e){var name=e.kind==="trade"?"Swap":e.kind==="payment"?"Payment":e.kind==="stake"?(e.tool==="stake"?"Stake":e.tool==="unstake"?"Unstake":"Stake withdrawn"):e.kind==="move"?"Move":e.kind==="dapp"?"App: "+(e.seller||""):e.tool==="cash out"?"Cash out":"Withdrawal";var st=e.status==="done"?"":(e.status==="failed"?' <span class="chip bad">failed</span>':' <span class="chip warn">pending</span>');var link=(e.tx&&EXP[e.chain]?' · <a target="_blank" rel="noopener" href="'+EXP[e.chain]+esc(e.tx)+'">tx</a>':"")+confChip(liveFor(e.tx));
return '<div class="row">'+kindIcon(e)+'<div style="min-width:0"><div>'+name+st+'</div><div class="sm mut" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px">'+esc(e.kind==="payment"?e.seller:(e.detail||""))+'</div><div class="sm mut">'+esc(e.chain||"")+' · '+ago(e.ts)+link+(e.reason?'<div class="sm bad" style="overflow-wrap:anywhere" title="'+esc(e.reason)+'">'+esc(shortWhy(e.reason))+'</div>':"")+'</div></div><div class="r">'+rowUsd(e)+(e.fee_usd?'<div class="sm mut">fee '+usd(e.fee_usd)+'</div>':"")+'</div></div>'}).join("")}
function approvals(){var p=S.pending;var ids=p.map(function(x){return x.id}).join();if(ids!==APIDS){APIDS=ids;APLOCK=Date.now()+700}var head='<h3>Waiting for you</h3>';if(!p.length)return head+'<div class="empty">Nothing to approve.<div class="sm" style="margin-top:6px">Trades over '+usd(S.policy.approval_above_usd)+' show up here and in Telegram while this page is open.</div></div>'+msg();
return head+p.map(function(x){return '<div class="ap">'+esc(x.text)+'<div class="sm mut" style="margin-top:6px">Expires '+new Date(x.expires).toLocaleTimeString()+'</div><div class="btns"><button class="b no" onclick="ans(\''+x.id+'\',\'denied\')">Deny</button><button class="b ok" onclick="ans(\''+x.id+'\',\'approved\')">Approve</button></div></div>'}).join("")+msg()}
var APIDS="",APLOCK=0;
function ans(id,d){if(Date.now()<APLOCK)return;api("/approve",{id:id,decision:d}).then(function(){flash=[1,d==="approved"?"Approved.":"Denied."];refresh()}).catch(function(e){flash=[0,e.message];render()})}
var LIMD={},LIMPW="";
function lv(id,def){return Object.prototype.hasOwnProperty.call(LIMD,id)?LIMD[id]:def}
function limIn(el){if(el.id==="pw1"){LIMPW=el.value;return}LIMD[el.id]=el.type==="checkbox"?el.checked:el.value;var u=document.getElementById("limun");if(u)u.hidden=false}
function limF(k,lab,hint,spent){var p=S.policy,v=lv("f_"+k,String(p[k])),sub="";
if(spent!=null){var pct=p[k]>0?Math.min(100,Math.round(spent/p[k]*100)):0;sub='<div class="bar"><i style="width:'+pct+'%"></i></div><div class="sm mut sth">Spent today '+usd(spent)+'</div>'}else if(hint)sub='<div class="sm mut sth">'+hint+'</div>';
return '<div><label for="f_'+k+'">'+lab+'</label><input id="f_'+k+'" type="number" min="0" step="any" inputmode="decimal" value="'+esc(v)+'" oninput="limIn(this)">'+sub+'</div>'}
function limT(id,on,text){var c=lv(id,on);return '<label><input type="checkbox" id="'+id+'"'+(c?" checked":"")+' onchange="limIn(this)"> '+text+'</label>'}
function setRow(icon,title,sub,btn){return '<div class="row">'+icon+'<div style="min-width:0"><div>'+title+'</div><div class="sm mut">'+sub+'</div></div><div class="r">'+btn+'</div></div>'}
var SICO={ai:'<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><rect x="7" y="7" width="10" height="10" rx="2"/>',tg:'<path d="M21 4L3 11l6 2 2 6 3-4 5 4z"/>',bk:'<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/>',ext:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>'};
function sIco(k){return '<div class="ic"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+SICO[k]+'</svg></div>'}
// Python bots (Settings, For developers) get the wallet's bot link (the same one AI apps use).
var PYO=null,PYPW="",PYMSG=null,PYBUSY=false;
var CODEICO='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16"/></svg>';
function tkClaude(){return !!(S&&S.ai&&S.ai.provider&&S.ai.provider.id==="tollkit")}
function pyLocalEnv(){var l=(S.connect||{}).launch||{},env=l.env||{};return Object.keys(env).filter(function(k){return /^TOLLKIT_WALLET_/.test(k)}).map(function(k){return 'export '+k+'="'+env[k]+'"'}).join("\n")}
function pyBody(){var c=S.connect||{},r=c.remote,lim=S.policy||{},m=PYMSG,n=0;
function step(t){n++;return '<div class="pystep"><span class="pyn">'+n+'</span><b>'+t+'</b></div>'}
var h='<h2>Python bots</h2><p class="ailead">Run your own trading bots in Python. They trade through this wallet, inside your limits, and can’t withdraw, change limits or see your keys.</p>';
h+=step("Install")+aiCode("py-i","pip install tollkit-wallet")+'<p class="aismall">Python 3.9 or newer. No other packages needed.</p>';
var ready=false,env="";
if(r){h+=step("Your bot link");
 if(!r.on){h+='<label class="ailbl" for="pypw">Wallet password</label><input id="pypw" class="aiin" type="password" autocomplete="current-password" placeholder="Needed to make the link" value="'+esc(PYPW)+'"><button class="b aigoap" data-pyact="on"'+(PYBUSY?" disabled":"")+'>'+(PYBUSY?"Making it…":"Make my bot link")+'</button>'+(m?'<div class="aim '+(m[0]?"ok":"bad")+'">'+esc(m[1])+'</div>':'')+'<p class="aismall">Your bot sends its requests to Tollkit’s server, which passes them to this wallet while Chrome is open and the wallet is unlocked. Your keys stay here.</p>'}
 else{ready=true;env='export TOLLKIT_LINK="'+r.url+'"';h+=aiCode("py-link",r.url)+'<p class="aismall"><span class="'+(r.online?"ok":"warn")+'">●</span> '+(r.online?"The wallet is reachable.":"Waiting for the wallet to check in…")+' Keep this link private: anyone with it can trade inside your limits. It’s the same link your AI apps use. Keep Chrome open with the wallet unlocked while a bot runs.</p>'+
 '<details class="pymore"><summary>New link or turn off</summary><label class="ailbl" for="pypw">Wallet password (for a new link)</label><input id="pypw" class="aiin" type="password" autocomplete="current-password" value="'+esc(PYPW)+'"><div class="btns" style="margin-top:8px"><button class="b g" data-pyact="new"'+(PYBUSY?" disabled":"")+'>New link</button><button class="b no" data-pyact="off"'+(PYBUSY?" disabled":"")+'>Turn off</button></div><p class="aismall">A new link stops the old one, for bots and AI apps alike.</p></details>'+(m?'<div class="aim '+(m[0]?"ok":"bad")+'">'+esc(m[1])+'</div>':'')}}
else{h+=step("Let your scripts unlock the wallet");
 if(c.ready){ready=true;env=pyLocalEnv();h+='<p class="aismall"><span class="ok">●</span> Saved. Scripts on this computer unlock the wallet with a copy of your password that only your account can read.</p>'}
 else h+='<label class="ailbl" for="pypw">Wallet password</label><input id="pypw" class="aiin" type="password" autocomplete="current-password" value="'+esc(PYPW)+'"><button class="b aigoap" data-pyact="pw"'+(PYBUSY?" disabled":"")+'>'+(PYBUSY?"Saving…":"Save it for my scripts")+'</button>'+(m?'<div class="aim '+(m[0]?"ok":"bad")+'">'+esc(m[1])+'</div>':'')+'<p class="aismall">Saves a copy of the password on this computer, readable only by your account. Anyone who can read it and your wallet folder could trade inside your limits.</p>'}
if(ready){h+=step("Try it")+aiCode("py-try",(env?env+"\n":"")+"tollkit-bot check\ntollkit-bot backtest dip-buyer\ntollkit-bot run dip-buyer")+'<p class="aismall">Paper trading (pretend money, live prices) unless you add <code>--live</code>. Built in: <code>dca</code>, <code>dip-buyer</code>, <code>momentum</code>, <code>rebalance</code>.'+(r?' On Windows PowerShell: <code>$env:TOLLKIT_LINK="…"</code>.':'')+'</p>'+
 step("Write your own")+aiCode("py-code",'from tollkit_wallet import Strategy, buy, hold\n\nclass BuyDips(Strategy):\n    token, chain = "ETH", "base"\n    def decide(self, m, notes):\n        if m.change_pct(24) is not None and m.change_pct(24) <= -5 and m.cash >= 20:\n            return buy(20, "down 5% in a day")\n        return hold()')+
 '<p class="aismall"><code>tollkit-bot new my_bot.py</code> writes a full example to edit. Trades over '+usd(lim.approval_above_usd||0)+' wait for you in Approvals.</p>'}
return h}
function pyRender(){if(!PYO)return;var d=PYO.querySelector(".aidlg"),sc=d.scrollTop,foc=document.activeElement&&document.activeElement.id==="pypw";PYO.querySelector(".aibody").innerHTML=pyBody();d.scrollTop=sc;var pw=document.getElementById("pypw");if(pw){pw.oninput=function(){PYPW=pw.value};if(foc)pw.focus()}}
function openPy(){if(!PYO){PYO=document.createElement("div");PYO.className="aio";PYO.innerHTML='<div class="aidlg" role="dialog" aria-modal="true" aria-label="Python bots"><button class="aix" aria-label="Close">×</button><div class="aibody"></div></div>';PYO.addEventListener("mousedown",function(e){if(e.target===PYO)closePy()});PYO.addEventListener("click",pyClick);document.body.appendChild(PYO)}pyRender()}
function closePy(){if(PYO){PYO.remove();PYO=null;PYPW="";PYMSG=null}}
function pyDo(act){if(act!=="off"&&!PYPW){PYMSG=[0,"Type your wallet password first."];pyRender();var p=document.getElementById("pypw");if(p)p.focus();return}
PYBUSY=true;PYMSG=null;pyRender();(act==="pw"?api("/ai/password",{password:PYPW}):api("/connect/remote",{password:PYPW,action:act})).then(function(){PYPW="";PYMSG=act==="off"?[1,"Turned off. No bot or app can reach the wallet now."]:act==="new"?[1,"New link made. Update it in your bots and AI apps."]:null;return refresh()}).catch(function(e){PYMSG=[0,e.message]}).then(function(){PYBUSY=false;pyRender()})}
function pyClick(e){var t=e.target.closest("button");if(!t)return;if(t.classList.contains("aix"))closePy();else if(t.hasAttribute("data-pyact"))pyDo(t.getAttribute("data-pyact"));else if(t.hasAttribute("data-copy")){var el=document.getElementById(t.getAttribute("data-copy")),v=el?el.textContent:"",done=function(){t.textContent="Copied";setTimeout(function(){t.textContent="Copy"},1500)};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(v).then(done,function(){fallback(v);done()});else{fallback(v);done()}}}
function pyStatus(){var c=S.connect||{},r=c.remote;if(r)return r.on?(r.online?'<span class="ok">●</span> Bot link on, wallet reachable':'<span class="warn">●</span> Bot link on, waiting for the wallet'):'No bot link yet';return c.ready?'<span class="ok">●</span> Ready for scripts on this computer':'Not set up yet'}
function pyCard(){return '<div class="pycard"><div class="pyct"><span class="tmico tmpy sm">'+CODEICO+'</span><div style="min-width:0"><b>Python bots</b><div class="sm mut">'+pyStatus()+'</div></div><button class="botcta" onclick="openPy()">'+(((S.connect||{}).remote||{}).on||(!(S.connect||{}).remote&&(S.connect||{}).ready)?"Show setup":"Set up")+ARROW+'</button></div></div>'}
function pyRow(){return setRow('<div class="ic">'+CODEICO.replace('aria-hidden','width="17" height="17" aria-hidden')+'</div>',"Python bots",'Run your own trading bots in Python, inside your limits. '+pyStatus(),'<button class="b g sbtn" onclick="openPy()">'+((((S.connect||{}).remote||{}).on)?"Setup":"Set up")+'</button>')}
function settings(){var p=S.policy,sp=S.spent_today||{},dirty=Object.keys(LIMD).length>0;
var lim='<h3>Spending limits</h3><div class="mut sm">Your AI and autopilot have to stay inside these and can\'t change them. Saving needs your password.</div>'+
'<div class="sgrp">Swaps</div><div class="grid2">'+limF("per_trade_usd","Per swap ($)","Largest single swap")+limF("daily_trades_usd","Swaps per day ($)",null,sp.trades_usd||0)+limF("approval_above_usd","Ask me above ($)","Bigger swaps wait for your OK")+limF("max_slippage_bps","Max slippage (bps)","100 bps = 1%")+'</div>'+
'<div class="sgrp">Paying for tools</div><div class="grid2">'+limF("per_payment_usd","Per payment ($)","Largest single payment")+limF("daily_payments_usd","Payments per day ($)",null,sp.payments_usd||0)+limF("per_seller_daily_usd","Per seller per day ($)","Most to any one seller")+'</div>'+
'<div class="sgrp">Networks</div><div class="toggles">'+ALLCH.map(function(c){return limT("c_"+c,p.chains.indexOf(c)>=0,CHAIN_NAMES[c])}).join("")+'</div>'+
'<div class="sgrp">Safety</div><div class="toggles stg">'+limT("f_bsw",p.block_seller_warnings,"Block sellers that fail the seller check")+limT("f_ar",p.agent_rules==="auto","Let agents turn on autopilot rules without asking me")+'</div>'+
'<label for="pw1">Password</label><input id="pw1" type="password" autocomplete="current-password" value="'+esc(LIMPW)+'" oninput="limIn(this)">'+
'<div class="ssave"><button class="b" onclick="saveLim()">Save limits</button><span id="limun" class="sm warn"'+(dirty?"":" hidden")+'>Unsaved changes</span></div>'+msg();
var on=((S.connect||{}).apps||[]).filter(function(a){return a.added}).map(function(a){return (AIMETA[a.id]||[0,a.id])[1]});
var ai=setRow(sIco("ai"),"Connected AI",on.length?esc(on.join(", ")):"None yet",'<button class="b g sbtn" onclick="openAI()">'+(on.length?"Manage":"Connect")+'</button>');
var tgOn=/telegram/.test(S.approvals||"");
var tg=setRow(sIco("tg"),"Telegram approvals",tgOn?'<span class="ok">On.</span> Swaps over '+usd(p.approval_above_usd)+' ask you there too.':'Off. Approvals only show on this page while it\'s open.',"")+
(tgOn?"":'<div class="sm mut sth">To get them on your phone, make a bot with @BotFather, then run:</div><div class="row"><code class="addr">tollkit-wallet telegram &lt;bot-token&gt; &lt;chat-id&gt;</code></div>');
var bk=S.backup||{},bkSub=bk.done?'<span class="ok">Backed up.</span>':(bk.kind==="keys"?"Not backed up yet. This wallet's backup is its two private keys.":"Not backed up yet.");
var bkr=setRow(sIco("bk"),"Backup",bkSub,'<button class="b g sbtn" onclick="openBk()">'+(bk.done?"Show again":"Back up")+'</button>');
var ex=S.ext||{paired:0,sites:[]};if(EXC&&ex.paired>EXCN)EXC=null;
var exr=setRow(sIco("ext"),"Browser extension",ex.paired?'<span class="ok">Paired</span> with '+ex.paired+' browser'+(ex.paired>1?"s":"")+'. Sites ask here, in Approvals.':"Lets websites connect to this wallet in Chrome, like MetaMask or Phantom.",'<button class="b g sbtn" onclick="extCode()">Pair a browser</button>')+
(EXC?'<div class="row" style="flex-wrap:wrap"><div style="min-width:0"><div class="sm mut">Paste this code into the Tollkit extension. It works once, for 5 minutes.</div><div class="addr" style="font-size:17px;letter-spacing:.06em;margin-top:4px">'+esc(EXC)+'</div></div><div class="r">'+cpBtn(EXC)+'</div></div>':'')+
(ex.sites.length?ex.sites.map(function(x){var h=x.origin.replace(/^https?:\/\//,"");return '<div class="row"><div style="min-width:0"><div>'+esc(h)+'</div><div class="sm mut">'+[x.evm?"EVM ("+EVMNAMES+")":"",x.solana?"Solana":""].filter(Boolean).join(" + ")+'</div></div><div class="r"><button class="b no sbtn" data-extoff="'+esc(x.origin)+'">Disconnect</button></div></div>'}).join(""):'')+
(ex.paired?'<div class="sm" style="margin-top:6px"><a href="#" onclick="extUnpair();return false">Unpair all browsers</a></div>':'');
return lim+'<h3>AI</h3>'+(S.ai&&S.ai.fuel?fuelRow():'')+ai+'<h3>For developers</h3>'+pyRow()+'<h3>Websites</h3>'+exr+'<h3>Approvals</h3>'+tg+'<h3>Recovery</h3>'+bkr}
var EXC=null,EXCN=0;
function extCode(){api("/extmgr/code",{}).then(function(r){EXC=r.code;EXCN=(S.ext||{}).paired||0;render()}).catch(function(e){flash=[0,e.message];render()})}
document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-extoff]");if(b)extOff(b.getAttribute("data-extoff"))});
function extOff(o){api("/extmgr/disconnect",{origin:o}).then(function(){refresh().then(function(){render()})})}
function extUnpair(){api("/extmgr/unpair",{}).then(function(){EXC=null;refresh().then(function(){render()})})}
function saveLim(){var F=["per_trade_usd","daily_trades_usd","approval_above_usd","max_slippage_bps","per_payment_usd","daily_payments_usd","per_seller_daily_usd"],p={},bad=null;F.forEach(function(k){var v=document.getElementById("f_"+k).value.trim();if(v===""||!isFinite(Number(v))||Number(v)<0)bad=bad||k;p[k]=Number(v)});
if(bad){flash=[0,"Enter a number for every limit."];render();return}
p.max_slippage_bps=Math.round(p.max_slippage_bps);p.chains=ALLCH.filter(function(c){return document.getElementById("c_"+c).checked});if(!p.chains.length){flash=[0,"Keep at least one network on."];render();return}
p.block_seller_warnings=document.getElementById("f_bsw").checked;p.agent_rules=document.getElementById("f_ar").checked?"auto":"propose";
var pw=document.getElementById("pw1").value;if(!pw){flash=[0,"Enter your password to save."];render();return}
api("/policy",{password:pw,policy:p}).then(function(){LIMD={};LIMPW="";flash=[1,"Saved."];refresh().then(function(){render()})}).catch(function(e){LIMPW="";flash=[0,e.message];render()})}
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
