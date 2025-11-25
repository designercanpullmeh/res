const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, proto } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const delay = ms => new Promise(r => setTimeout(r, ms));
const CONFIG_PATH = './config.json';
let config = { admin: '76656576352338@s.whatsapp.net', subadmins: [] };
if (fs.existsSync(CONFIG_PATH)) config = JSON.parse(fs.readFileSync(CONFIG_PATH));
function ensureJid(j) { if (!j) return j; return j.includes('@') ? j : `${j}@s.whatsapp.net`; }
config.admin = ensureJid(config.admin);
config.subadmins = (config.subadmins || []).map(ensureJid);
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }
const groupStates = {};
function getStateFor(group) {
    if (!groupStates[group]) {
        groupStates[group] = {
            isSpamming: false, spamText: '', spamInterval: null,
            isRenaming: false, renameInterval: null, renameList: null,
            baseName: '',
            sharedDelay: 1000 // ms for both spam/nc
        };
    }
    return groupStates[group];
}
function normalizeBare(jid){ if(!jid) return ''; return jid.replace(/:\d+$/,'').replace(/@.*/,''); }
function isAdminOrSub(sender) { const s = normalizeBare(sender); const adminBare = normalizeBare(config.admin); const subsBare = (config.subadmins||[]).map(normalizeBare); return s === adminBare || subsBare.includes(s); }
function isOnlyAdmin(sender) { const s = normalizeBare(sender); const adminBare = normalizeBare(config.admin); return s === adminBare; }

async function connectBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const latest = await fetchLatestBaileysVersion();
    const version = Array.isArray(latest) ? latest[0] : (latest.version || latest);
    if (proto && typeof proto === 'object') {
        if (!proto.GroupStatusMessageV2 && proto.GroupStatusMessage) proto.GroupStatusMessageV2 = proto.GroupStatusMessage;
        if (!proto.Message && proto.IMessage) proto.Message = proto.IMessage;
    }
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '22.04']
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'open') console.log('FIGHT BOT connected 🎯');
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        const isGroup = from?.endsWith?.('@g.us');
        const sender = msg.key.participant || msg.key.remoteJid;
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const isCommand = typeof body === 'string' && body.startsWith('/');
        const command = isCommand ? body.split(' ')[0].toLowerCase() : '';
        const args = isCommand ? body.split(' ').slice(1).join(' ') : '';
        const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const quoted = { quoted: { key: { remoteJid: from, id: msg.key.id, fromMe: msg.key.fromMe, participant: msg.key.participant || undefined }, message: msg.message } };
        const st = getStateFor(from);

        if (isCommand && isAdminOrSub(sender)) {
            switch (command) {
                case '/menu': {
                    const text = `🎯 FIGHT BOT MENU 🛡️
/start
/startnc
/stopspam
/spam
/setdelay
/stopnc
/help
`;
                    const mentions = [config.admin, ...config.subadmins];
                    await sock.sendMessage(from, { text, mentions }, quoted);
                    break;
                }
                case '/status': {
                    const ownerLabel = `@${config.admin.replace('@s.whatsapp.net','')}`;
                    const subsLabel = config.subadmins.length ? config.subadmins.map(j => `@${j.replace('@s.whatsapp.net','')}`).join(' ') : 'None';
                    const text = `🎯 *FIGHT BOT STATUS* 🥊
Spam: ${st.isSpamming ? 'ON 🟢' : 'OFF 🔴'}
NC: ${st.isRenaming ? 'ON 🟢' : 'OFF 🔴'}
Delay: ${st.sharedDelay/1000} seconds
Owner: ${ownerLabel}
Subadmins: ${subsLabel}
`;
                    const mentions = [config.admin, ...config.subadmins];
                    await sock.sendMessage(from, { text, mentions }, quoted);
                    break;
                }
                case '/setdelay':
                    if (!args) { await sock.sendMessage(from, { text: 'Provide seconds (ex: /setdelay 2)', ...quoted }); break; }
                    {
                        const sd = parseFloat(args);
                        if (isNaN(sd) || sd <= 0) { await sock.sendMessage(from, { text: 'Invalid value.', ...quoted }); break; }
                        st.sharedDelay = Math.max(100, Math.round(sd * 1000));
                        if (st.isSpamming && st.spamInterval) { clearInterval(st.spamInterval); st.spamInterval = setInterval(() => { sock.sendMessage(from, { text: st.spamText }); }, st.sharedDelay); }
                        if (st.isRenaming && st.renameInterval) { clearInterval(st.renameInterval); if (st.renameList && st.renameList.length) { let idx = 0; st.renameInterval = setInterval(async () => { try { await sock.groupUpdateSubject(from, st.renameList[idx % st.renameList.length]); } catch {} idx++; }, st.sharedDelay); } }
                        await sock.sendMessage(from, { text: `Delay set to ${sd} seconds for both spam and NC.`, ...quoted });
                    }
                    break;

                case '/spam':
                    if (!args) { await sock.sendMessage(from, { text: 'Provide text (/spam message)', ...quoted }); break; }
                    if (st.isSpamming) { await sock.sendMessage(from, { text: 'Spam is running.', ...quoted }); break; }
                    st.isSpamming = true;
                    st.spamText = args;
                    st.spamInterval = setInterval(() => { sock.sendMessage(from, { text: st.spamText }); }, st.sharedDelay);
                    await sock.sendMessage(from, { text: 'Spam started 🥊.', ...quoted });
                    break;
                case '/stopspam':
                    if (!st.isSpamming) { await sock.sendMessage(from, { text: 'Spam not running.', ...quoted }); break; }
                    clearInterval(st.spamInterval); st.isSpamming = false; st.spamInterval = null;
                    await sock.sendMessage(from, { text: 'Spam stopped 🛑.', ...quoted });
                    break;

                case '/startnc':
                    if (!isGroup) { await sock.sendMessage(from, { text: 'Use in group.', ...quoted }); break; }
                    if (st.isRenaming) { await sock.sendMessage(from, { text: 'NC already running.', ...quoted }); break; }
                    if (!args) { await sock.sendMessage(from, { text: 'Provide names: /startnc name1|name2|...', ...quoted }); break; }
                    st.isRenaming = true;
                    st.renameList = args.includes('|') ? args.split('|').map(s => s.trim()).filter(Boolean) : [args];
                    let idxParts = 0;
                    st.renameInterval = setInterval(async () => {
                        const newName = st.renameList[idxParts % st.renameList.length];
                        try { await sock.groupUpdateSubject(from, newName); } catch {}
                        idxParts++;
                    }, st.sharedDelay);
                    await sock.sendMessage(from, { text: 'NC started 🥊.', ...quoted });
                    break;

                case '/stopnc':
                    if (!st.isRenaming) { await sock.sendMessage(from, { text: 'No NC running.', ...quoted }); break; }
                    clearInterval(st.renameInterval); st.isRenaming = false; st.renameInterval = null;
                    await sock.sendMessage(from, { text: 'NC stopped 🛑.', ...quoted });
                    break;

                case '/addsubadmin':
                    if (!isOnlyAdmin(sender)) { await sock.sendMessage(from, { text: 'Only owner can add subadmins.', ...quoted }); break; }
                    {
                        let target;
                        if (mentioned && mentioned.length > 0) target = mentioned[0];
                        else if (args) { const num = args.replace(/\D/g,''); if (num) target = ensureJid(num); }
                        if (!target) { await sock.sendMessage(from, { text: 'Tag or provide number.', ...quoted }); break; }
                        target = ensureJid(target);
                        if (!config.subadmins.includes(target)) { config.subadmins.push(target); saveConfig(); await sock.sendMessage(from, { text: 'Subadmin added.', ...quoted }); }
                        break;
                    }
                case '/removesubadmin':
                    if (!isOnlyAdmin(sender)) { await sock.sendMessage(from, { text: 'Only owner can remove subadmins.', ...quoted }); break; }
                    {
                        let target;
                        if (mentioned && mentioned.length > 0) target = mentioned[0];
                        else if (args) { const num = args.replace(/\D/g,''); if (num) target = ensureJid(num); }
                        if (!target) { await sock.sendMessage(from, { text: 'Tag or provide number.', ...quoted }); break; }
                        target = ensureJid(target);
                        config.subadmins = config.subadmins.filter(x => x !== target);
                        saveConfig();
                        await sock.sendMessage(from, { text: 'Subadmin removed.', ...quoted });
                    }
                    break;
                case '/help':
                    await sock.sendMessage(from, { text: `FIGHT BOT 🎯 Commands:
/spam <msg>         Start spam
/stopspam           Stop spam
/startnc <names>    Start group name cycling
/stopnc             Stop NC
/setdelay <sec>     Set interval (both spam & NC)
/status             Show status
/menu
/help
`, ...quoted });
                    break;
            }
        }
    });

    return sock;
}
connectBot();

// --- Express Server for Render (keepalive & health endpoints) ---
const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Fight Bot online!'));
app.get('/health', (req, res) => res.json({status: 'ok', message: 'Fight Bot running.'}));
app.listen(PORT, () => {
  console.log(`[FightBot] HTTP server LIVE on port ${PORT}`);
});
