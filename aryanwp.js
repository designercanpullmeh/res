const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, proto } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const CONFIG_PATH = './config.json';
const STATE_PATH = './state.json';

// --- Config (owner, subadmins) ---
let config = { admin: '76656576352338@s.whatsapp.net', subadmins: [] };
if (fs.existsSync(CONFIG_PATH)) config = JSON.parse(fs.readFileSync(CONFIG_PATH));

function ensureJid(j) { if (!j) return j; return j.includes('@') ? j : `${j}@s.whatsapp.net`; }
config.admin = ensureJid(config.admin);
config.subadmins = (config.subadmins || []).map(ensureJid);
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }

// --- Persistent bot state (spam + NC) ---
// spamStates: { [groupJid]: { isSpamming, spamText, spamDelayMs } }
// ncStates:   { [groupJid]: { isRenaming, renameList, ncDelayMs } }
let botState = {
    spamStates: {},
    ncStates: {}
};
if (fs.existsSync(STATE_PATH)) {
    try {
        botState = JSON.parse(fs.readFileSync(STATE_PATH));
    } catch (e) {
        console.error('Failed to load state.json, using defaults', e);
    }
}
function saveState() {
    try {
        fs.writeFileSync(STATE_PATH, JSON.stringify(botState, null, 2));
        console.log('state saved');
    } catch (e) {
        console.error('Failed to save state.json', e);
    }
}

// --- In‑memory runtime state ---
const groupStates = {};
function getStateFor(group) {
    if (!groupStates[group]) {
        groupStates[group] = {
            // spam
            isSpamming: false,
            spamText: '',
            spamInterval: null,
            spamDelayMs: 1000,  // default 1s
            // nc
            isRenaming: false,
            renameInterval: null,
            renameList: null,
            ncDelayMs: 700,     // default 0.7s
            _ncIndex: 0
        };

        // hydrate from persisted state
        const sSpam = botState.spamStates[group];
        const sNc   = botState.ncStates[group];
        if (sSpam) {
            groupStates[group].isSpamming   = !!sSpam.isSpamming;
            groupStates[group].spamText     = sSpam.spamText || '';
            groupStates[group].spamDelayMs  = sSpam.spamDelayMs || 1000;
        }
        if (sNc) {
            groupStates[group].isRenaming   = !!sNc.isRenaming;
            groupStates[group].renameList   = sNc.renameList || null;
            groupStates[group].ncDelayMs    = sNc.ncDelayMs || 700;
        }
    }
    return groupStates[group];
}

// --- Helpers ---
function normalizeBare(jid){ if(!jid) return ''; return jid.replace(/:\d+$/,'').replace(/@.*/,''); }
function isAdminOrSub(sender) {
    const s = normalizeBare(sender);
    const adminBare = normalizeBare(config.admin);
    const subsBare = (config.subadmins||[]).map(normalizeBare);
    return s === adminBare || subsBare.includes(s);
}
function isOnlyAdmin(sender) {
    const s = normalizeBare(sender);
    const adminBare = normalizeBare(config.admin);
    return s === adminBare;
}

// emoji pool (single emojis, 25+)
const NC_EMOJI_BLOCKS = [
    '💥','🔥','⚔️','🥊','💣','👊','😈','💀','⚡','🛡️',
    '🏹','🧨','🚀','💫','⭐','🌟','✨','⚙️','🌀','💎',
    '💢','🔱','🩸','☠️','🎯','🏴','🦴'
];
function randomEmojiBlock() {
    return NC_EMOJI_BLOCKS[Math.floor(Math.random() * NC_EMOJI_BLOCKS.length)];
}

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

    // auto-resume helper
    function resumeFromState() {
        // resume spam
        for (const from in botState.spamStates) {
            const s = botState.spamStates[from];
            if (!s || !s.isSpamming || !s.spamText) continue;
            const st = getStateFor(from);
            if (st.spamInterval) continue; // already running
            st.isSpamming  = true;
            st.spamText    = s.spamText;
            st.spamDelayMs = s.spamDelayMs || st.spamDelayMs;
            st.spamInterval = setInterval(() => {
                sock.sendMessage(from, { text: st.spamText });
            }, st.spamDelayMs);
            console.log('Resumed spam in', from);
        }
        // resume NC
        for (const from in botState.ncStates) {
            const s = botState.ncStates[from];
            if (!s || !s.isRenaming || !s.renameList || !s.renameList.length) continue;
            const st = getStateFor(from);
            if (st.renameInterval) continue; // already running
            st.isRenaming = true;
            st.renameList = s.renameList;
            st.ncDelayMs  = s.ncDelayMs || st.ncDelayMs;
            st._ncIndex   = 0;

            const runNc = async () => {
                if (!st.isRenaming || !st.renameList || !st.renameList.length) return;
                const base = st.renameList[st._ncIndex % st.renameList.length];
                const name = `${randomEmojiBlock()} ${base}`;
                try { await sock.groupUpdateSubject(from, name); } catch {}
                st._ncIndex = (st._ncIndex + 1) || 1;
                st.renameInterval = setTimeout(runNc, st.ncDelayMs);
            };
            st.renameInterval = setTimeout(runNc, st.ncDelayMs);
            console.log('Resumed NC in', from, 'delay', st.ncDelayMs, 'ms');
        }
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'open') {
            console.log('FIGHT BOT connected 🎯');
            resumeFromState();
        }
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
/spam
/stopspam
/setdelay
/startnc
/stopnc
/setncdelay
/status
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
Spam: ${st.isSpamming ? 'ON 🟢' : 'OFF 🔴'} (delay: ${st.spamDelayMs/1000}s)
NC: ${st.isRenaming ? 'ON 🟢' : 'OFF 🔴'} (delay: ${st.ncDelayMs/1000}s)
Owner: ${ownerLabel}
Subadmins: ${subsLabel}
`;
                    const mentions = [config.admin, ...config.subadmins];
                    await sock.sendMessage(from, { text, mentions }, quoted);
                    break;
                }

                // per-group spam delay
                case '/setdelay':
                    if (!args) { await sock.sendMessage(from, { text: 'Provide seconds (ex: /setdelay 0.3)', ...quoted }); break; }
                    {
                        const sd = parseFloat(args);
                        if (isNaN(sd) || sd <= 0) { await sock.sendMessage(from, { text: 'Invalid value.', ...quoted }); break; }
                        st.spamDelayMs = Math.max(50, Math.round(sd * 1000)); // allow fast but not 0

                        if (st.isSpamming && st.spamInterval) {
                            clearInterval(st.spamInterval);
                            st.spamInterval = setInterval(() => {
                                sock.sendMessage(from, { text: st.spamText });
                            }, st.spamDelayMs);
                        }

                        botState.spamStates[from] = botState.spamStates[from] || {};
                        botState.spamStates[from].spamDelayMs = st.spamDelayMs;
                        if (botState.spamStates[from].spamText == null) botState.spamStates[from].spamText = st.spamText || '';
                        saveState();

                        await sock.sendMessage(from, { text: `Spam delay set to ${sd} seconds.`, ...quoted });
                    }
                    break;

                // per-group NC delay
                case '/setncdelay':
                    if (!args) { await sock.sendMessage(from, { text: 'Provide seconds (ex: /setncdelay 0.7)', ...quoted }); break; }
                    {
                        const nd = parseFloat(args);
                        if (isNaN(nd) || nd <= 0) { await sock.sendMessage(from, { text: 'Invalid value.', ...quoted }); break; }
                        st.ncDelayMs = Math.max(100, Math.round(nd * 1000)); // keep >100ms to avoid insta-ban

                        if (st.isRenaming && st.renameInterval) {
                            clearTimeout(st.renameInterval);
                            const runNc = async () => {
                                if (!st.isRenaming || !st.renameList || !st.renameList.length) return;
                                const base = st.renameList[st._ncIndex % st.renameList.length];
                                const name = `${randomEmojiBlock()} ${base}`;
                                try { await sock.groupUpdateSubject(from, name); } catch {}
                                st._ncIndex = (st._ncIndex + 1) || 1;
                                st.renameInterval = setTimeout(runNc, st.ncDelayMs);
                            };
                            st.renameInterval = setTimeout(runNc, st.ncDelayMs);
                        }

                        botState.ncStates[from] = botState.ncStates[from] || {};
                        botState.ncStates[from].ncDelayMs = st.ncDelayMs;
                        if (botState.ncStates[from].renameList == null) botState.ncStates[from].renameList = st.renameList || [];
                        saveState();

                        await sock.sendMessage(from, { text: `NC delay set to ${nd} seconds.`, ...quoted });
                    }
                    break;

                case '/spam':
                    if (!args) { await sock.sendMessage(from, { text: 'Provide text (/spam message)', ...quoted }); break; }
                    if (st.isSpamming) { await sock.sendMessage(from, { text: 'Spam is running.', ...quoted }); break; }

                    st.isSpamming = true;
                    st.spamText = args;
                    st.spamInterval = setInterval(() => {
                        sock.sendMessage(from, { text: st.spamText });
                    }, st.spamDelayMs);

                    botState.spamStates[from] = {
                        isSpamming: true,
                        spamText: st.spamText,
                        spamDelayMs: st.spamDelayMs
                    };
                    saveState();

                    await sock.sendMessage(from, { text: `Spam started 🥊 (delay ${st.spamDelayMs/1000}s).`, ...quoted });
                    break;

                case '/stopspam':
                    if (!st.isSpamming) { await sock.sendMessage(from, { text: 'Spam not running.', ...quoted }); break; }
                    clearInterval(st.spamInterval);
                    st.isSpamming = false;
                    st.spamInterval = null;

                    botState.spamStates[from] = {
                        isSpamming: false,
                        spamText: st.spamText,
                        spamDelayMs: st.spamDelayMs
                    };
                    saveState();

                    await sock.sendMessage(from, { text: 'Spam stopped 🛑.', ...quoted });
                    break;

                case '/startnc':
                    if (!isGroup) { await sock.sendMessage(from, { text: 'Use in group.', ...quoted }); break; }
                    if (st.isRenaming) { await sock.sendMessage(from, { text: 'NC already running.', ...quoted }); break; }
                    if (!args) { await sock.sendMessage(from, { text: 'Provide names: /startnc name1|name2|...', ...quoted }); break; }

                    st.isRenaming = true;
                    st.renameList = args.includes('|') ? args.split('|').map(s => s.trim()).filter(Boolean) : [args];
                    st._ncIndex = 0;

                    botState.ncStates[from] = {
                        isRenaming: true,
                        renameList: st.renameList,
                        ncDelayMs: st.ncDelayMs
                    };
                    saveState();

                    const runNc = async () => {
                        if (!st.isRenaming || !st.renameList || !st.renameList.length) return;
                        const base = st.renameList[st._ncIndex % st.renameList.length];
                        const name = `${randomEmojiBlock()} ${base}`;
                        try { await sock.groupUpdateSubject(from, name); } catch {}
                        st._ncIndex = (st._ncIndex + 1) || 1;
                        st.renameInterval = setTimeout(runNc, st.ncDelayMs);
                    };
                    st.renameInterval = setTimeout(runNc, st.ncDelayMs);

                    await sock.sendMessage(from, { text: `NC started 🥊 (delay ${st.ncDelayMs/1000}s).`, ...quoted });
                    break;

                case '/stopnc':
                    if (!st.isRenaming) { await sock.sendMessage(from, { text: 'No NC running.', ...quoted }); break; }
                    clearTimeout(st.renameInterval);
                    st.isRenaming = false;
                    st.renameInterval = null;

                    botState.ncStates[from] = {
                        isRenaming: false,
                        renameList: st.renameList,
                        ncDelayMs: st.ncDelayMs
                    };
                    saveState();

                    await sock.sendMessage(from, { text: 'NC stopped 🛑.', ...quoted });
                    break;

                case '/restart':
                    if (!isOnlyAdmin(sender)) {
                        await sock.sendMessage(from, { text: 'Only owner can restart bot state.', ...quoted });
                        break;
                    }

                    Object.keys(groupStates).forEach(g => {
                        const gs = groupStates[g];
                        if (gs.spamInterval) clearInterval(gs.spamInterval);
                        if (gs.renameInterval) clearTimeout(gs.renameInterval);
                        gs.isSpamming = false;
                        gs.isRenaming = false;
                        gs.spamText = '';
                        gs.renameList = null;
                    });

                    botState = { spamStates: {}, ncStates: {} };
                    saveState();
                    Object.keys(groupStates).forEach(k => delete groupStates[k]);

                    await sock.sendMessage(from, { text: '🔄 Bot fully restarted! All spam/NC cleared. Fresh start 🥊', ...quoted });
                    break;

                case '/addsubadmin':
                    if (!isOnlyAdmin(sender)) { await sock.sendMessage(from, { text: 'Only owner can add subadmins.', ...quoted }); break; }
                    {
                        let target;
                        if (mentioned && mentioned.length > 0) target = mentioned[0];
                        else if (args) {
                            const num = args.replace(/\D/g,'');
                            if (num) target = ensureJid(num);
                        }
                        if (!target) { await sock.sendMessage(from, { text: 'Tag or provide number.', ...quoted }); break; }
                        target = ensureJid(target);
                        if (!config.subadmins.includes(target)) {
                            config.subadmins.push(target);
                            saveConfig();
                            await sock.sendMessage(from, { text: 'Subadmin added.', ...quoted });
                        }
                        break;
                    }

                case '/removesubadmin':
                    if (!isOnlyAdmin(sender)) { await sock.sendMessage(from, { text: 'Only owner can remove subadmins.', ...quoted }); break; }
                    {
                        let target;
                        if (mentioned && mentioned.length > 0) target = mentioned[0];
                        else if (args) {
                            const num = args.replace(/\D/g,'');
                            if (num) target = ensureJid(num);
                        }
                        if (!target) { await sock.sendMessage(from, { text: 'Tag or provide number.', ...quoted }); break; }
                        target = ensureJid(target);
                        config.subadmins = config.subadmins.filter(x => x !== target);
                        saveConfig();
                        await sock.sendMessage(from, { text: 'Subadmin removed.', ...quoted });
                    }
                    break;

                case '/help':
                    await sock.sendMessage(from, { text: `FIGHT BOT2 🎯 Commands:
/spam <msg>           Start spam
/stopspam             Stop spam
/setdelay <sec>       Set spam delay (per group)
/startnc <names>      Start group name cycling
/stopnc               Stop NC
/setncdelay <sec>     Set NC delay (per group)
/status               Show status
/restart              Clear all state
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