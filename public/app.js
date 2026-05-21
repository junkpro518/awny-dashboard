const state = {
  users: [],
  selectedUserId: null,
  selectedUser: null,
  conversations: [],
  detailsClosed: false,
  refreshTimer: null,
  searchTimer: null
};

const els = {
  loginView: document.querySelector('#loginView'),
  appView: document.querySelector('#appView'),
  loginForm: document.querySelector('#loginForm'),
  loginError: document.querySelector('#loginError'),
  usernameInput: document.querySelector('#usernameInput'),
  passwordInput: document.querySelector('#passwordInput'),
  logoutButton: document.querySelector('#logoutButton'),
  themeToggle: document.querySelector('#themeToggle'),
  searchInput: document.querySelector('#searchInput'),
  userList: document.querySelector('#userList'),
  refreshButton: document.querySelector('#refreshButton'),
  refreshStatus: document.querySelector('#refreshStatus'),
  conversationTitle: document.querySelector('#conversationTitle'),
  conversationSubtitle: document.querySelector('#conversationSubtitle'),
  messageList: document.querySelector('#messageList'),
  detailsPanel: document.querySelector('#detailsPanel'),
  userDetails: document.querySelector('#userDetails'),
  closeDetails: document.querySelector('#closeDetails'),
  detailsToggle: document.querySelector('#detailsToggle'),
  mobileUsersButton: document.querySelector('#mobileUsersButton'),
  exportAllJson: document.querySelector('#exportAllJson'),
  exportAllCsv: document.querySelector('#exportAllCsv'),
  exportUserJson: document.querySelector('#exportUserJson'),
  exportUserCsv: document.querySelector('#exportUserCsv')
};

init();

async function init() {
  applySavedTheme();
  bindEvents();
  try {
    await api('/api/session');
    showApp();
    await loadUsers();
    startAutoRefresh();
  } catch {
    showLogin();
  }
}

function bindEvents() {
  els.loginForm.addEventListener('submit', handleLogin);
  els.logoutButton.addEventListener('click', handleLogout);
  els.themeToggle.addEventListener('click', toggleTheme);
  els.refreshButton.addEventListener('click', () => refreshAll({ force: true }));
  els.searchInput.addEventListener('input', () => {
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(loadUsers, 220);
  });
  els.closeDetails.addEventListener('click', closeDetailsPanel);
  els.detailsToggle.addEventListener('click', openDetailsPanel);
  els.mobileUsersButton.addEventListener('click', () => els.userList.closest('.sidebar').classList.toggle('open'));
  els.exportAllJson.addEventListener('click', () => download('/api/export.json'));
  els.exportAllCsv.addEventListener('click', () => download('/api/export.csv'));
  els.exportUserJson.addEventListener('click', () => download(`/api/export.json?telegramUserId=${encodeURIComponent(state.selectedUserId)}`));
  els.exportUserCsv.addEventListener('click', () => download(`/api/export.csv?telegramUserId=${encodeURIComponent(state.selectedUserId)}`));
}

async function handleLogin(event) {
  event.preventDefault();
  els.loginError.textContent = '';
  const username = els.usernameInput.value.trim();
  const password = els.passwordInput.value;
  try {
    await api('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    els.passwordInput.value = '';
    showApp();
    await loadUsers();
    startAutoRefresh();
  } catch (error) {
    els.loginError.textContent = error.message || 'تعذر تسجيل الدخول.';
  }
}

async function handleLogout() {
  try {
    await api('/logout', { method: 'POST' });
  } finally {
    state.selectedUserId = null;
    state.users = [];
    state.conversations = [];
    stopAutoRefresh();
    showLogin();
  }
}

async function loadUsers() {
  const q = els.searchInput.value.trim();
  const payload = await api(`/api/users?q=${encodeURIComponent(q)}`);
  state.users = payload.data || [];
  renderUsers();

  if (state.selectedUserId && state.users.some((user) => String(user.telegram_user_id) === String(state.selectedUserId))) {
    await loadConversation(state.selectedUserId, { keepDetails: true });
  } else if (state.users.length && !state.selectedUserId) {
    await selectUser(state.users[0].telegram_user_id);
  } else if (!state.users.length) {
    renderEmptyConversation();
  }

  els.refreshStatus.textContent = `آخر تحديث: ${formatTime(new Date().toISOString())}`;
}

async function selectUser(telegramUserId) {
  state.selectedUserId = String(telegramUserId);
  await loadConversation(telegramUserId);
  renderUsers();
  els.userList.closest('.sidebar').classList.remove('open');
}

async function loadConversation(telegramUserId, options = {}) {
  const payload = await api(`/api/users/${encodeURIComponent(telegramUserId)}/conversations`);
  state.selectedUser = payload.user;
  state.conversations = payload.data || [];
  renderConversation();
  renderDetails();
  if (!options.keepDetails && window.matchMedia('(max-width: 1100px)').matches) {
    els.detailsPanel.classList.remove('open');
  }
}

async function refreshAll() {
  try {
    await loadUsers();
  } catch (error) {
    els.refreshStatus.textContent = 'تعذر التحديث';
  }
}

function renderUsers() {
  if (!state.users.length) {
    els.userList.innerHTML = '<div class="empty-state">لا توجد محادثات مطابقة.</div>';
    return;
  }

  els.userList.innerHTML = '';
  for (const user of state.users) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `user-card ${String(user.telegram_user_id) === String(state.selectedUserId) ? 'active' : ''}`;
    button.innerHTML = `
      <span class="user-card-row">
        <span class="user-name">${escapeHtml(user.display_name)}</span>
        <span class="count-pill">${user.message_count}</span>
      </span>
      <span class="user-meta">${escapeHtml(formatUserMeta(user))}</span>
      <span class="message-preview">${escapeHtml(user.latest_message || 'لا توجد معاينة')}</span>
      <span class="meta-row">
        <span>${escapeHtml(formatTime(user.last_seen))}</span>
        <span>${escapeHtml(user.telegram_user_id)}</span>
      </span>
    `;
    button.addEventListener('click', () => selectUser(user.telegram_user_id));
    els.userList.append(button);
  }
}

function renderConversation() {
  const user = state.selectedUser;
  els.detailsToggle.disabled = !user;
  els.exportUserJson.disabled = !state.selectedUserId;
  els.exportUserCsv.disabled = !state.selectedUserId;
  els.conversationTitle.textContent = user?.display_name || 'محادثة المستخدم';
  els.conversationSubtitle.textContent = user
    ? `${formatUserMeta(user)} · ${user.message_count} رسالة · آخر تفاعل ${formatTime(user.last_seen)}`
    : 'ستظهر المحادثة الكاملة هنا.';

  if (!state.conversations.length) {
    els.messageList.innerHTML = '<div class="empty-state">لا توجد محادثات لهذا المستخدم.</div>';
    return;
  }

  els.messageList.innerHTML = '';
  for (const item of state.conversations) {
    const group = document.createElement('article');
    group.className = 'message-group';
    group.innerHTML = `
      <div class="message user">
        <div class="message-label">الطالب</div>
        <div class="message-bubble">${escapeHtml(item.message_text || 'رسالة بدون نص')}</div>
      </div>
      <div class="message bot">
        <div class="message-label">عوني</div>
        <div class="message-bubble">${escapeHtml(item.bot_response || 'لا يوجد رد مسجل')}</div>
        <div class="message-meta">
          <span>${escapeHtml(formatTime(item.created_at))}</span>
          <span>Execution: ${escapeHtml(item.execution_id || '-')}</span>
          <span>Message: ${escapeHtml(item.telegram_message_id || '-')}</span>
        </div>
      </div>
    `;
    els.messageList.append(group);
  }
  els.messageList.scrollTop = els.messageList.scrollHeight;
}

function renderDetails() {
  const user = state.selectedUser;
  if (!user) {
    els.userDetails.innerHTML = '<p class="empty-state">اضغط على اسم المستخدم لعرض التفاصيل.</p>';
    return;
  }

  const fullName = [user.telegram_first_name, user.telegram_last_name].filter(Boolean).join(' ') || '-';
  els.userDetails.innerHTML = `
    <div class="detail-list">
      ${detailItem('الاسم', user.display_name)}
      ${detailItem('Telegram ID', user.telegram_user_id)}
      ${detailItem('Chat ID', user.telegram_chat_id || '-')}
      ${detailItem('Username', user.telegram_username ? `@${user.telegram_username}` : '-')}
      ${detailItem('الاسم من Telegram', fullName)}
      ${detailItem('عدد الرسائل', user.message_count)}
      ${detailItem('أول تفاعل', formatTime(user.first_seen))}
      ${detailItem('آخر تفاعل', formatTime(user.last_seen))}
      <div class="detail-item">
        <span>Execution IDs</span>
        <div class="execution-list">${(user.execution_ids || []).map((id) => `<span>${escapeHtml(id)}</span>`).join('') || '<strong>-</strong>'}</div>
      </div>
      ${detailItem('آخر رسالة', user.latest_message || '-')}
    </div>
  `;
  els.detailsPanel.classList.add('open');
}

function renderEmptyConversation() {
  state.selectedUserId = null;
  state.selectedUser = null;
  state.conversations = [];
  els.conversationTitle.textContent = 'لا توجد محادثات';
  els.conversationSubtitle.textContent = 'غيّر البحث أو تحقق من جدول Supabase.';
  els.messageList.innerHTML = '<div class="empty-state">لا توجد بيانات لعرضها.</div>';
  renderDetails();
}

function closeDetailsPanel() {
  state.detailsClosed = true;
  els.appView.classList.add('details-closed');
  els.detailsPanel.classList.remove('open');
}

function openDetailsPanel() {
  if (!state.selectedUser) return;
  state.detailsClosed = false;
  els.appView.classList.remove('details-closed');
  els.detailsPanel.classList.add('open');
}

function detailItem(label, value) {
  return `
    <div class="detail-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? '-')}</strong>
    </div>
  `;
}

function showLogin() {
  els.loginView.hidden = false;
  els.appView.hidden = true;
  els.usernameInput.focus();
}

function showApp() {
  els.loginView.hidden = true;
  els.appView.hidden = false;
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.refreshTimer = window.setInterval(refreshAll, 30000);
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function applySavedTheme() {
  const theme = localStorage.getItem('awny-theme') || 'light';
  document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('awny-theme', next);
}

function download(path) {
  window.location.href = path;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function formatUserMeta(user) {
  const username = user.telegram_username ? `@${user.telegram_username}` : 'بدون username';
  return `${username} · ${user.telegram_user_id}`;
}

function formatTime(value) {
  if (!value) return '-';
  try {
    return new Intl.DateTimeFormat('ar-SA', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
