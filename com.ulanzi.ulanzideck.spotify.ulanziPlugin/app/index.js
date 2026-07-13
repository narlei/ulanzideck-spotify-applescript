'use strict';

const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ── Action UUIDs ─────────────────────────────────────────────────────────────
const PLUGIN_UUID = 'com.ulanzi.ulanzideck.spotify';
const A = {
  play:             'com.ulanzi.ulanzideck.spotify.play',
  previous:         'com.ulanzi.ulanzideck.spotify.previous',
  next:             'com.ulanzi.ulanzideck.spotify.next',
  shuffle:          'com.ulanzi.ulanzideck.spotify.shuffle',
  repeat:           'com.ulanzi.ulanzideck.spotify.repeat',
  volumeMute:       'com.ulanzi.ulanzideck.spotify.volumemute',
  volumeSet:        'com.ulanzi.ulanzideck.spotify.volumeset',
  volumeUp:         'com.ulanzi.ulanzideck.spotify.volumeup',
  volumeDown:       'com.ulanzi.ulanzideck.spotify.volumedown',
  nowPlaying:       'com.ulanzi.ulanzideck.spotify.nowplaying',
  playController:   'com.ulanzi.ulanzideck.spotify.playcontroller',
  volumeController: 'com.ulanzi.ulanzideck.spotify.volumecontroller',
  seekController:   'com.ulanzi.ulanzideck.spotify.seekcontroller',
};

// ── AppleScript helper ────────────────────────────────────────────────────────
function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// ── Minimal WebSocket client (zero external deps) ─────────────────────────────
function connectWebSocket(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const listeners = {};

    const ws = {
      send(data) {
        const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
        const len = payload.length;
        const mask = crypto.randomBytes(4);
        const headerSize = len > 65535 ? 10 : len > 125 ? 4 : 2;
        const frame = Buffer.alloc(headerSize + 4 + len);
        frame[0] = 0x81; // FIN + text frame
        if (len > 65535) {
          frame[1] = 0x80 | 127;
          frame.writeBigUInt64BE(BigInt(len), 2);
        } else if (len > 125) {
          frame[1] = 0x80 | 126;
          frame.writeUInt16BE(len, 2);
        } else {
          frame[1] = 0x80 | len;
        }
        mask.copy(frame, headerSize);
        for (let i = 0; i < len; i++) frame[headerSize + 4 + i] = payload[i] ^ mask[i % 4];
        socket.write(frame);
      },
      on(event, fn) { listeners[event] = fn; return ws; },
      close() { socket.destroy(); },
    };

    function processFrames() {
      while (buf.length >= 2) {
        const b1 = buf[1];
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buf.length < 4) break;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) break;
          payloadLen = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        if (masked) offset += 4;
        if (buf.length < offset + payloadLen) break;
        const opcode = buf[0] & 0x0f;
        const payload = buf.subarray(offset, offset + payloadLen);
        buf = buf.subarray(offset + payloadLen);
        if (opcode === 0x1 || opcode === 0x2) {
          if (listeners.message) listeners.message(payload.toString());
        } else if (opcode === 0x8) {
          socket.destroy();
          break;
        } else if (opcode === 0x9) {
          // reply with pong
          const pong = Buffer.alloc(2);
          pong[0] = 0x8a; pong[1] = 0;
          socket.write(pong);
        }
      }
    }

    socket.on('connect', () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });

    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        upgraded = true;
        buf = buf.subarray(end + 4);
        resolve(ws);
      }
      processFrames();
    });

    socket.on('error', err => { if (!upgraded) reject(err); else if (listeners.error) listeners.error(err); });
    socket.on('close', () => { if (listeners.close) listeners.close(); });
  });
}

// ── Now Playing cache & animation ─────────────────────────────────────────────
let artworkCache = { url: null, dataUri: null };
let nowPlayingInfo = { name: '', artist: '' };
let nowPlayingTextIdx = 0; // alternates 0=name, 1=artist

function fetchArtwork(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const mime = res.headers['content-type'] || 'image/jpeg';
        resolve(`data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function refreshNowPlaying() {
  try {
    const url = await osascript('tell application "Spotify" to artwork url of current track');
    if (!url) return;
    if (artworkCache.url !== url) {
      artworkCache.dataUri = await fetchArtwork(url);
      artworkCache.url = url;
    }
    const raw = await osascript(
      'tell application "Spotify"\n' +
      '  return (name of current track) & "|" & (artist of current track)\n' +
      'end tell'
    );
    const [name, artist] = raw.split('|');
    nowPlayingInfo = { name: name || '', artist: artist || '' };
  } catch {
    // Spotify may not be running
  }
}

function buildNowPlayingImage(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="256" height="256">` +
    `<defs>` +
      `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0%" stop-color="black" stop-opacity="0"/>` +
        `<stop offset="100%" stop-color="black" stop-opacity="0.85"/>` +
      `</linearGradient>` +
      `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">` +
        `<feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="black" flood-opacity="0.9"/>` +
      `</filter>` +
    `</defs>` +
    `<image href="${artworkCache.dataUri}" x="0" y="0" width="256" height="256"/>` +
    `<rect x="0" y="160" width="256" height="96" fill="url(#g)"/>` +
    `<text x="128" y="232" font-family="Arial,sans-serif" font-size="20" font-weight="bold" ` +
    `fill="white" text-anchor="middle" dominant-baseline="middle" filter="url(#shadow)">${escaped}</text>` +
    `</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function sendNowPlaying(uuid, actionid, key) {
  if (!artworkCache.dataUri) return;
  const text = nowPlayingTextIdx === 0 ? nowPlayingInfo.name : nowPlayingInfo.artist;
  const data = buildNowPlayingImage(text);
  ws.send(JSON.stringify({
    cmd: 'state',
    uuid: PLUGIN_UUID,
    param: {
      statelist: [{ uuid, actionid, key, type: 1, data, textData: '', showtext: false }],
    },
  }));
}

// ── Plugin state ──────────────────────────────────────────────────────────────
const buttons = new Map(); // actionid → { uuid, actionid, key, param }
let muteVolume = null;     // saved volume before mute (global, one Spotify instance)
let ws;

function sendState(uuid, actionid, key, state) {
  ws.send(JSON.stringify({
    cmd: 'state',
    uuid: PLUGIN_UUID,
    param: {
      statelist: [{ uuid, actionid, key, type: 0, state, textData: '', showtext: false }],
    },
  }));
}

function sendDisplay(uuid, actionid, key, text) {
  ws.send(JSON.stringify({
    cmd: 'state',
    uuid: PLUGIN_UUID,
    param: {
      statelist: [{ uuid, actionid, key, type: 0, textData: text, showtext: true }],
    },
  }));
}

// ── Spotify state ─────────────────────────────────────────────────────────────
async function getSpotifyState() {
  try {
    const raw = await osascript(
      'tell application "Spotify"\n' +
      '  return (player state as string) & "|" & (shuffling as string) & "|" & (repeating as string)\n' +
      'end tell'
    );
    const [ps, sh, rp] = raw.split('|');
    return { isPlaying: ps === 'playing', shuffle: sh === 'true', repeat: rp === 'true' };
  } catch {
    return null;
  }
}

// ── Action handlers ───────────────────────────────────────────────────────────
async function handleAction(uuid, actionid, key, param) {
  try {
    switch (uuid) {
      case A.play:
      case A.playController: {
        await osascript('tell application "Spotify" to playpause');
        const ps = await getSpotifyState();
        if (ps) sendState(uuid, actionid, key, ps.isPlaying ? 1 : 0);
        break;
      }

      case A.previous:
        await osascript('tell application "Spotify" to previous track');
        break;

      case A.next:
        await osascript('tell application "Spotify" to next track');
        break;

      case A.shuffle: {
        await osascript('tell application "Spotify" to set shuffling to not shuffling');
        const sh = (await osascript('tell application "Spotify" to shuffling')) === 'true';
        sendState(uuid, actionid, key, sh ? 0 : 1); // 0=On icon, 1=Off icon
        break;
      }

      case A.repeat: {
        await osascript('tell application "Spotify" to set repeating to not repeating');
        const rp = (await osascript('tell application "Spotify" to repeating')) === 'true';
        sendState(uuid, actionid, key, rp ? 0 : 2); // 0=Context(on), 2=Off
        break;
      }

      case A.volumeMute:
      case A.volumeController: {
        if (muteVolume !== null) {
          await osascript(`tell application "Spotify" to set sound volume to ${muteVolume}`);
          muteVolume = null;
          if (uuid === A.volumeMute) sendState(uuid, actionid, key, 0);
        } else {
          const raw = await osascript('tell application "Spotify" to sound volume');
          muteVolume = parseInt(raw, 10) || 50;
          await osascript('tell application "Spotify" to set sound volume to 0');
          if (uuid === A.volumeMute) sendState(uuid, actionid, key, 1);
        }
        break;
      }

      case A.volumeUp:
        await osascript(
          'tell application "Spotify"\n' +
          '  set v to sound volume + 10\n' +
          '  if v > 100 then set v to 100\n' +
          '  set sound volume to v\n' +
          'end tell'
        );
        break;

      case A.volumeDown:
        await osascript(
          'tell application "Spotify"\n' +
          '  set v to sound volume - 10\n' +
          '  if v < 0 then set v to 0\n' +
          '  set sound volume to v\n' +
          'end tell'
        );
        break;

      case A.volumeSet: {
        const target = Math.max(0, Math.min(100, parseInt(param.volumeValue, 10) || 50));
        await osascript(`tell application "Spotify" to set sound volume to ${target}`);
        break;
      }

      case A.seekController:
        await osascript('tell application "Spotify" to set player position to 0');
        break;

    }
  } catch {
    // Spotify may not be running or another transient error
  }
}

async function handleDialRotate(uuid, actionid, key, param, rotateEvent) {
  const isRight = rotateEvent === 'right' || rotateEvent === 'hold-right';
  try {
    if (uuid === A.playController) {
      if (isRight) await osascript('tell application "Spotify" to next track');
      else await osascript('tell application "Spotify" to previous track');
    } else if (uuid === A.volumeController) {
      const step = parseInt(param.volumeStep, 10) || 10;
      const delta = isRight ? step : -step;
      await osascript(
        'tell application "Spotify"\n' +
        `  set v to sound volume + (${delta})\n` +
        '  if v > 100 then set v to 100\n' +
        '  if v < 0 then set v to 0\n' +
        '  set sound volume to v\n' +
        'end tell'
      );
    } else if (uuid === A.seekController) {
      const step = parseInt(param.seekStep, 10) || 15;
      const delta = isRight ? step : -step;
      await osascript(
        'tell application "Spotify"\n' +
        `  set p to player position + (${delta})\n` +
        '  if p < 0 then set p to 0\n' +
        '  set player position to p\n' +
        'end tell'
      );
    }
  } catch {
    // Spotify may not be running
  }
}

// ── Initial state when a button appears on the deck ───────────────────────────
async function updateButtonOnAdd(uuid, actionid, key) {
  const state = await getSpotifyState();
  if (!state) return;
  if (uuid === A.play) {
    sendState(uuid, actionid, key, state.isPlaying ? 1 : 0);
  } else if (uuid === A.nowPlaying) {
    await refreshNowPlaying();
    sendNowPlaying(uuid, actionid, key);
  } else if (uuid === A.shuffle) {
    sendState(uuid, actionid, key, state.shuffle ? 0 : 1);
  } else if (uuid === A.repeat) {
    sendState(uuid, actionid, key, state.repeat ? 0 : 2);
  } else if (uuid === A.volumeMute) {
    sendState(uuid, actionid, key, muteVolume !== null ? 1 : 0);
  }
}

// ── Polling loop — keeps button states in sync with Spotify ──────────────────
async function pollState() {
  const state = await getSpotifyState();
  if (!state) return;

  let nowPlayingRefreshed = false;
  let trackInfo = null;

  for (const btn of buttons.values()) {
    const { uuid, actionid, key } = btn;
    try {
      if (uuid === A.play) {
        sendState(uuid, actionid, key, state.isPlaying ? 1 : 0);
      } else if (uuid === A.nowPlaying) {
        if (!nowPlayingRefreshed) { await refreshNowPlaying(); nowPlayingRefreshed = true; }
        sendNowPlaying(uuid, actionid, key);
      } else if (uuid === A.shuffle) {
        sendState(uuid, actionid, key, state.shuffle ? 0 : 1);
      } else if (uuid === A.repeat) {
        sendState(uuid, actionid, key, state.repeat ? 0 : 2);
      } else if (uuid === A.volumeMute) {
        sendState(uuid, actionid, key, muteVolume !== null ? 1 : 0);
      } else if (uuid === A.playController) {
        if (!trackInfo) {
          trackInfo = await osascript(
            'tell application "Spotify"\n' +
            '  return (name of current track) & "\\n" & (artist of current track)\n' +
            'end tell'
          ).catch(() => '');
        }
        if (trackInfo) sendDisplay(uuid, actionid, key, trackInfo);
      }
    } catch { /* ignore per-button errors */ }
  }
}

// ── Message router ────────────────────────────────────────────────────────────
async function handleMessage(data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  const { uuid, cmd, actionid, key, param = {}, rotateEvent } = msg;

  switch (cmd) {
    case 'add':
      buttons.set(actionid, { uuid, actionid, key, param });
      await updateButtonOnAdd(uuid, actionid, key).catch(() => {});
      break;

    case 'clear':
      buttons.delete(actionid);
      break;

    case 'run':
    case 'dialdown':
      await handleAction(uuid, actionid, key, param).catch(() => {});
      break;

    case 'dialrotate':
      await handleDialRotate(uuid, actionid, key, param, rotateEvent).catch(() => {});
      break;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const host = process.argv[2] || '127.0.0.1';
  const port = parseInt(process.argv[3], 10);

  ws = await connectWebSocket(host, port);

  ws.on('message', data => handleMessage(data).catch(() => {}));
  ws.on('close', () => process.exit(0));
  ws.on('error', () => {});

  // Register with UlanziDeck
  ws.send(JSON.stringify({ uuid: PLUGIN_UUID, cmd: 'connected', code: 0 }));

  // Poll Spotify state every 3 seconds to keep buttons in sync
  setInterval(() => pollState().catch(() => {}), 3000);

  // Animate now playing text — alternate song name / artist every 2 seconds
  setInterval(() => {
    nowPlayingTextIdx = nowPlayingTextIdx === 0 ? 1 : 0;
    for (const btn of buttons.values()) {
      if (btn.uuid === A.nowPlaying) sendNowPlaying(btn.uuid, btn.actionid, btn.key);
    }
  }, 2000);
}

main().catch(err => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
