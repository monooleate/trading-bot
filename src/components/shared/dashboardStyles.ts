export const dashboardCSS = `
.ec-header{border-bottom:1px solid var(--border);padding:13px 26px;display:flex;align-items:center;justify-content:space-between;background:var(--surface)}
.ec-logo{font-family:var(--mono);font-size:11px;color:var(--accent);letter-spacing:.15em;text-transform:uppercase}
.ec-logo span{color:var(--muted)}
.ec-tabs{display:flex;border-bottom:1px solid var(--border);background:var(--surface);padding:0 26px;overflow-x:auto}
.ec-tab{background:none;border:none;color:var(--muted);font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:12px 17px;cursor:pointer;border-bottom:2px solid transparent;transition:all .2s;position:relative;top:1px;white-space:nowrap}
.ec-tab:hover{color:var(--text)}
.ec-tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.ec-content{padding:24px;max-width:1200px;margin:0 auto}
.ec-grid2{display:grid;grid-template-columns:1fr 1fr;gap:15px}
.ec-card{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:19px}
.ec-card-title{font-family:var(--mono);font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted);margin-bottom:15px;display:flex;align-items:center;gap:7px}
.ec-card-title::before{content:'';display:inline-block;width:6px;height:6px;background:var(--accent);border-radius:50%}
.ec-field{margin-bottom:12px}
.ec-field label{display:block;font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px}
.ec-field input,.ec-field select{width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:13px;padding:8px 10px;border-radius:2px;outline:none;transition:border-color .2s;-webkit-appearance:none;appearance:none}
.ec-field input:focus,.ec-field select:focus{border-color:var(--accent)}
.ec-field input[type=range]{padding:5px 0;background:none;border:none;accent-color:var(--accent);cursor:pointer}
.ec-big{font-family:var(--mono);font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1}
.ec-big-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-top:3px}
.ec-pos{color:var(--accent)}.ec-neg{color:var(--danger)}.ec-neu{color:var(--accent2)}.ec-warn{color:var(--warn)}
.ec-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:12px}
.ec-row:last-child{border-bottom:none}
.ec-row .lbl{color:var(--muted);font-size:11px}
.ec-row .val{font-weight:700}
.ec-verdict{margin-top:14px;padding:12px;border-radius:2px;font-family:var(--mono);font-size:11px;line-height:1.6;border-left:3px solid}
.ec-verdict.go{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
.ec-verdict.wait{background:#1f1400;border-color:var(--warn);color:var(--warn)}
.ec-verdict.stop{background:#1f0000;border-color:var(--danger);color:var(--danger)}
.ec-info{background:var(--surface2);border:1px solid var(--border);border-radius:2px;padding:12px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.7;margin-top:12px}
.ec-info strong{color:var(--text)}
.ec-sec-title{font-family:var(--sans);font-size:18px;font-weight:800;margin-bottom:3px;letter-spacing:-.02em}
.ec-sec-sub{font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:19px}
.ec-tbl{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px}
.ec-tbl th{text-align:left;padding:6px 9px;font-size:10px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--border)}
.ec-tbl td{padding:8px 9px;border-bottom:1px solid #151520;vertical-align:middle}
.ec-tbl tr:hover td{background:var(--surface2);cursor:pointer}
.ec-badge{display:inline-block;padding:1px 6px;border-radius:2px;font-size:10px;font-family:var(--mono);letter-spacing:.05em;font-weight:700}
.ec-badge.green{background:#0f2000;color:var(--accent);border:1px solid #1a3300}
.ec-badge.red{background:#200000;color:var(--danger);border:1px solid #330000}
.ec-badge.yellow{background:#1f1400;color:var(--warn);border:1px solid #332200}
.ec-divider{border:none;border-top:1px solid var(--border);margin:14px 0}
.ec-kelly-wrap{margin-top:5px;background:var(--surface2);border-radius:2px;height:6px;overflow:hidden}
.ec-kelly-bar{height:100%;background:var(--accent);border-radius:2px;transition:width .5s ease}
.ec-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;padding:7px 12px;border-radius:2px;cursor:pointer;transition:all .2s;letter-spacing:.08em;text-transform:uppercase}
.ec-btn:hover{border-color:var(--accent);color:var(--accent)}
.ec-btn.primary{background:var(--accent);color:#0a0a0c;font-weight:700;border-color:var(--accent)}
.ec-btn.primary:hover{background:#d4ff40}
.ec-btn:disabled{opacity:.4;cursor:not-allowed}
.ec-tag{display:inline-block;padding:1px 5px;border-radius:2px;font-size:9px;font-family:var(--mono);background:var(--surface2);border:1px solid var(--border);color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
.ec-chip-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:13px;align-items:center}
.ec-chip{background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:3px 10px;font-family:var(--mono);font-size:10px;color:var(--muted);cursor:pointer;transition:all .2s;text-transform:uppercase;letter-spacing:.07em}
.ec-chip:hover,.ec-chip.active{background:#0f1f00;border-color:var(--accent);color:var(--accent)}
.ec-mq{max-width:290px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.ec-upload{border:2px dashed var(--border);border-radius:4px;padding:26px;text-align:center;font-family:var(--mono);font-size:12px;color:var(--muted);cursor:pointer;transition:all .2s}
.ec-upload:hover{border-color:var(--accent);color:var(--accent);background:#0f1f00}
.ec-sdot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px}
.ec-sdot.live{background:var(--accent);box-shadow:0 0 6px var(--accent);animation:pulse 2s infinite}
.ec-sdot.off{background:var(--muted)}
.ec-swarm-canvas{width:100%;height:260px;background:var(--surface2);border-radius:4px;border:1px solid var(--border);position:relative;overflow:hidden}
.ec-agent{position:absolute;border-radius:50%;transform:translate(-50%,-50%);transition:all .55s ease;cursor:default;user-select:none}
.ec-agent.pulse{animation:agentPulse .38s ease}
.ec-sbar-row{display:flex;align-items:center;gap:9px;margin-bottom:9px}
.ec-sbar-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);width:110px;text-align:right;flex-shrink:0;text-transform:uppercase;letter-spacing:.05em}
.ec-sbar-track{flex:1;height:18px;background:var(--surface2);border-radius:2px;overflow:hidden;position:relative}
.ec-sbar-fill{height:100%;border-radius:2px;transition:width .8s ease}
.ec-sbar-val{position:absolute;right:5px;top:50%;transform:translateY(-50%);font-family:var(--mono);font-size:10px;font-weight:700;color:var(--bg)}
.ec-sbar-val.out{right:auto;left:calc(100% + 5px);color:var(--text)}
.ec-rnd{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:10px;padding:3px 9px;background:var(--surface2);border:1px solid var(--border);border-radius:2px;color:var(--muted)}
.ec-rnd.on{border-color:var(--accent);color:var(--accent)}
.ec-simlog{height:110px;overflow-y:auto;font-family:var(--mono);font-size:10px;color:var(--muted);line-height:1.9;border:1px solid var(--border);background:var(--surface2);padding:9px;border-radius:2px}
.ec-simlog .e{border-bottom:1px solid #151520;padding:1px 0}
.ec-simlog .e.hi{color:var(--accent2)}
.ec-simlog .e.wn{color:var(--warn)}
.ec-consensus{font-family:var(--mono);font-size:44px;font-weight:700;letter-spacing:-.03em;line-height:1;text-align:center;margin:10px 0}
.ec-vs{display:flex;align-items:center;justify-content:center;gap:16px;margin:13px 0}
.ec-vs-block{text-align:center}
.ec-vs-num{font-family:var(--mono);font-size:24px;font-weight:700}
.ec-vs-lbl{font-family:var(--mono);font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-top:2px}
.ec-vs-sep{font-family:var(--mono);font-size:14px;color:var(--border)}
.ec-home-link{font-family:var(--mono);font-size:10px;color:var(--muted);text-decoration:none;letter-spacing:.1em;text-transform:uppercase;transition:color .15s}
.ec-home-link:hover{color:var(--accent)}
@media(max-width:768px){.ec-grid2{grid-template-columns:1fr}.ec-content{padding:13px}}
`;
