/**
 * Codex CLI → OpenAI-compatible HTTP proxy
 * Avec approbations interactives via boutons Telegram inline keyboard
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT        = process.env.PROXY_PORT   || 3001;
const CODEX_BIN   = process.env.CODEX_BIN   || 'codex';
const CODEX_MODEL = process.env.CODEX_MODEL  || undefined;
const WORKDIR     = process.env.CODEX_WORKDIR || os.homedir();
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID  = process.env.TELEGRAM_APPROVAL_CHAT_ID || '1665447187';

// Map des approbations en attente : cmdId → { resolve }
const pendingApprovals = new Map();
let tgOffset = 0;

// ─── Telegram helpers ──────────────────────────────────────────────────────

async function tgApi(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendApprovalRequest(cmdId, description) {
  await tgApi('sendMessage', {
    chat_id: TG_CHAT_ID,
    text: `🔐 *Approbation requise*\n\n\`${description}\``,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approuver', callback_data: `approve:${cmdId}` },
        { text: '❌ Refuser',   callback_data: `deny:${cmdId}`    },
      ]],
    },
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(cmdId);
      resolve(false); // timeout = refus automatique
      tgApi('sendMessage', { chat_id: TG_CHAT_ID, text: '⏱ Délai expiré — action refusée.' });
    }, 120_000);

    pendingApprovals.set(cmdId, {
      resolve: (approved) => {
        clearTimeout(timer);
        pendingApprovals.delete(cmdId);
        resolve(approved);
      },
    });
  });
}

// Note : pas de polling Telegram ici — OpenClaw poll déjà le même bot.
// Les approbations sont loggées dans le journal systemd.

// ─── Appel codex avec interception des approbations ───────────────────────

function messagesToPrompt(messages) {
  return messages.map((m) => {
    const content = Array.isArray(m.content)
      ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : (m.content || '');
    switch (m.role) {
      case 'system':    return `[SYSTEM]\n${content}`;
      case 'assistant': return `[ASSISTANT]\n${content}`;
      default:          return `[USER]\n${content}`;
    }
  }).join('\n\n---\n\n');
}

function callCodex(prompt) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `codex-out-${crypto.randomUUID()}.txt`);

    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      '-C', WORKDIR,
      '-o', outFile,
    ];
    if (CODEX_MODEL) args.push('-m', CODEX_MODEL);
    args.push('-');

    const proc = spawn(CODEX_BIN, args, {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Buffer pour les lignes incomplètes
    let stdoutBuf = '';
    let lastEventDesc = null;
    let stallTimer = null;

    // Quand stdout stagne → codex attend une approbation
    function resetStall() {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(async () => {
        if (!proc.exitCode && lastEventDesc) {
          console.log(`[approval] attente approbation : ${lastEventDesc}`);
          const approved = await sendApprovalRequest(crypto.randomUUID(), lastEventDesc);
          proc.stdin.write(approved ? 'y\n' : 'n\n');
        }
      }, 2500); // 2,5s sans output = en attente
    }

    proc.stdout.on('data', (chunk) => {
      resetStall();
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop(); // garder la ligne incomplète

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          // Extraire une description lisible de l'événement
          if (evt.type === 'agent_action' || evt.type === 'exec_request' || evt.type === 'tool_call') {
            const cmd = evt.command || evt.action?.command || evt.input?.command || JSON.stringify(evt).slice(0, 120);
            lastEventDesc = cmd;
          } else if (evt.type === 'message' && evt.role === 'assistant') {
            // message texte final — pas besoin d'approbation
            lastEventDesc = null;
          }
        } catch {
          // ligne non-JSON (logs texte) → on garde comme description
          if (line.length > 5 && line.length < 300) lastEventDesc = line;
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const txt = chunk.toString().trim();
      if (txt) console.error(`[codex stderr] ${txt}`);
    });

    proc.on('close', (code) => {
      clearTimeout(stallTimer);
      let response = '';
      if (fs.existsSync(outFile)) {
        response = fs.readFileSync(outFile, 'utf8').trim();
        fs.unlinkSync(outFile);
      }
      if (!response && code !== 0) {
        return reject(new Error(`codex exited ${code}`));
      }
      resolve(response || '(aucune réponse)');
    });

    proc.on('error', reject);

    // Envoyer le prompt via stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    resetStall();

    // Timeout global 5 min
    setTimeout(() => {
      proc.kill();
      reject(new Error('Timeout global codex (5 min)'));
    }, 300_000);
  });
}

// ─── Serveur HTTP OpenAI-compatible ───────────────────────────────────────

function buildResponse(content) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'codex-cli',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'codex-cli', object: 'model' }] }));
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { messages = [], stream = false } = JSON.parse(body);
        const prompt = messagesToPrompt(messages);
        console.log(`[${new Date().toISOString()}] → codex (${messages.length} msgs)`);

        const content = await callCodex(prompt);
        console.log(`[${new Date().toISOString()}] ← réponse (${content.length} chars)`);

        if (stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const chunk = { id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'codex-cli', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildResponse(content)));
      } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Codex proxy → http://0.0.0.0:${PORT}`);
  console.log(`  workdir : ${WORKDIR}`);
  console.log(`  mode : bypass sandbox (usage personnel)`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
