const entryView = document.querySelector('#entry-view');
const chatView = document.querySelector('#chat-view');
const roomForm = document.querySelector('#room-form');
const displayName = document.querySelector('#display-name');
const roomCode = document.querySelector('#room-code');
const roomKey = document.querySelector('#room-key');
const joinFields = document.querySelector('#join-fields');
const formError = document.querySelector('#form-error');
const submitLabel = document.querySelector('#form-submit-label');
const messageArea = document.querySelector('#message-area');
const emptyState = document.querySelector('#empty-state');
const messageForm = document.querySelector('#message-form');
const messageInput = document.querySelector('#message-input');
const memberStatus = document.querySelector('#member-status');
const inviteStrip = document.querySelector('#invite-strip');
const toast = document.querySelector('#toast');

const config = window.TWOROOM_CONFIG || {};
const hasConfig = config.supabaseUrl && config.supabaseAnonKey && !config.supabaseAnonKey.includes('PASTE_');
const supabaseClient = hasConfig && window.supabase
  ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey)
  : null;

let mode = 'create';
let session = null;
let currentUser = null;
let roomChannel = null;
let toastTimer = null;

function setError(message) { formError.textContent = message; }

function setMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll('.mode-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
  joinFields.hidden = mode !== 'join';
  submitLabel.textContent = mode === 'join' ? '进入房间' : '创建我的房间';
  setError('');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function setBusy(busy) {
  const button = roomForm.querySelector('button[type="submit"]');
  button.disabled = busy;
  button.style.opacity = busy ? '.65' : '';
}

function saveSession() { localStorage.setItem('two-room-session', JSON.stringify(session)); }

function setRoomUrl() {
  const url = new URL(window.location.href);
  url.search = `?room=${encodeURIComponent(session.room)}&key=${encodeURIComponent(session.key)}`;
  history.replaceState({}, '', url);
}

function randomToken(length) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('');
}

async function hashKey(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function ensureAuth() {
  if (!supabaseClient) throw new Error('请先在 public/config.js 填入 Supabase anon public key');
  const existing = await supabaseClient.auth.getSession();
  if (existing.error) throw existing.error;
  if (existing.data.session) {
    currentUser = existing.data.session.user;
    return currentUser;
  }
  const anonymous = await supabaseClient.auth.signInAnonymously();
  if (anonymous.error) throw anonymous.error;
  currentUser = anonymous.data.user;
  return currentUser;
}

function supabaseError(error) {
  const message = error?.message || '网络暂时不可用';
  if (message.includes('Anonymous')) return '请在 Supabase 的 Authentication → Providers 中开启 Anonymous sign-ins';
  if (message.includes('房间代码') || message.includes('私密口令')) return '房间代码或私密口令不正确';
  if (message.includes('两位成员')) return '这个房间已经有两位成员了';
  return message;
}

async function createRoom(name) {
  const key = randomToken(10);
  const code = randomToken(6);
  const result = await supabaseClient.rpc('create_room', {
    p_room_code: code,
    p_invite_key_hash: await hashKey(key),
    p_display_name: name,
  });
  if (result.error) throw result.error;
  const created = result.data?.[0];
  if (!created) throw new Error('房间创建失败');
  return { room: created.room_code, roomId: created.room_id, key, name };
}

async function joinRoom(name, code, key) {
  const result = await supabaseClient.rpc('join_room', {
    p_room_code: code,
    p_invite_key_hash: await hashKey(key),
    p_display_name: name,
  });
  if (result.error) throw result.error;
  const joined = result.data?.[0];
  if (!joined) throw new Error('加入房间失败');
  return { room: joined.room_code, roomId: joined.room_id, key, name };
}

async function loadRoom() {
  const members = await supabaseClient.from('room_members')
    .select('user_id, display_name').eq('room_id', session.roomId).order('joined_at', { ascending: true });
  if (members.error) throw members.error;
  updateMemberStatus(members.data || []);

  const messages = await supabaseClient.from('messages')
    .select('id, sender_id, body, created_at').eq('room_id', session.roomId)
    .order('created_at', { ascending: true }).limit(300);
  if (messages.error) throw messages.error;
  (messages.data || []).forEach(renderMessage);
}

function subscribeToRoom() {
  if (roomChannel) supabaseClient.removeChannel(roomChannel);
  roomChannel = supabaseClient.channel(`room:${session.roomId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${session.roomId}`,
    }, (payload) => renderMessage(payload.new))
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'room_members', filter: `room_id=eq.${session.roomId}`,
    }, async () => {
      const members = await supabaseClient.from('room_members').select('user_id, display_name').eq('room_id', session.roomId);
      updateMemberStatus(members.data || []);
    })
    .subscribe();
}

function updateMemberStatus(members) {
  const otherCount = members.filter((member) => member.user_id !== currentUser?.id).length;
  memberStatus.textContent = otherCount ? '两位成员已连接' : '等待另一位成员';
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function renderMessage(message) {
  if (document.querySelector(`[data-message-id="${message.id}"]`)) return;
  emptyState.hidden = true;
  const row = document.createElement('div');
  row.className = `message-row${message.sender_id === currentUser?.id ? ' mine' : ''}`;
  row.dataset.messageId = message.id;
  const meta = document.createElement('p');
  meta.className = 'message-meta';
  meta.textContent = `${message.sender_id === currentUser?.id ? '我' : '对方'} · ${formatTime(message.created_at)}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.body;
  row.append(meta, bubble);
  messageArea.appendChild(row);
  messageArea.scrollTop = messageArea.scrollHeight;
}

async function enterRoom(nextSession) {
  session = nextSession;
  saveSession();
  setRoomUrl();
  entryView.hidden = true;
  chatView.hidden = false;
  document.querySelector('#invite-code').textContent = session.room;
  document.querySelector('#invite-key').textContent = session.key;
  messageArea.querySelectorAll('.message-row').forEach((node) => node.remove());
  emptyState.hidden = false;
  await loadRoom();
  subscribeToRoom();
}

async function submitRoom(event) {
  event.preventDefault();
  setError('');
  const name = displayName.value.trim();
  if (!name) return;
  setBusy(true);
  try {
    await ensureAuth();
    const nextSession = mode === 'create'
      ? await createRoom(name)
      : await joinRoom(name, roomCode.value.trim().toUpperCase(), roomKey.value.trim().toUpperCase());
    await enterRoom(nextSession);
  } catch (error) {
    setError(supabaseError(error));
  } finally {
    setBusy(false);
  }
}

async function submitMessage(event) {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !session || !currentUser) return;
  messageInput.disabled = true;
  const result = await supabaseClient.from('messages').insert({
    room_id: session.roomId, sender_id: currentUser.id, body: text,
  }).select('id, sender_id, body, created_at').single();
  if (result.error) showToast(supabaseError(result.error));
  else {
    messageInput.value = '';
    messageInput.style.height = 'auto';
    renderMessage(result.data);
  }
  messageInput.disabled = false;
  messageInput.focus();
}

function leaveRoom(clearSaved = true) {
  if (roomChannel) supabaseClient?.removeChannel(roomChannel);
  roomChannel = null;
  session = null;
  currentUser = null;
  if (clearSaved) localStorage.removeItem('two-room-session');
  chatView.hidden = true;
  entryView.hidden = false;
  const url = new URL(window.location.href);
  url.search = '';
  history.replaceState({}, '', url);
}

async function copyInvite() {
  const link = new URL(window.location.origin);
  link.search = `?room=${encodeURIComponent(session.room)}&key=${encodeURIComponent(session.key)}`;
  try {
    await navigator.clipboard.writeText(`小房间邀请：${link.href}`);
    showToast('邀请链接已复制');
  } catch {
    showToast(`代码 ${session.room} · 口令 ${session.key}`);
  }
}

document.querySelectorAll('.mode-button').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
roomForm.addEventListener('submit', submitRoom);
messageForm.addEventListener('submit', submitMessage);
document.querySelector('#leave-room').addEventListener('click', () => leaveRoom());
document.querySelector('#invite-button').addEventListener('click', () => { inviteStrip.hidden = !inviteStrip.hidden; });
document.querySelector('#copy-invite').addEventListener('click', copyInvite);
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 110)}px`;
});
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});
roomCode.addEventListener('input', () => { roomCode.value = roomCode.value.toUpperCase(); });
roomKey.addEventListener('input', () => { roomKey.value = roomKey.value.toUpperCase(); });

const query = new URLSearchParams(window.location.search);
const savedSession = JSON.parse(localStorage.getItem('two-room-session') || 'null');
if (query.get('room') && query.get('key')) {
  setMode('join');
  roomCode.value = query.get('room');
  roomKey.value = query.get('key');
} else if (savedSession && savedSession.room && savedSession.roomId && savedSession.key && savedSession.name) {
  displayName.value = savedSession.name;
  ensureAuth().then(() => enterRoom(savedSession)).catch((error) => setError(supabaseError(error)));
}
