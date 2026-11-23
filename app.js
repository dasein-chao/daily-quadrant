(function () {
  'use strict';

  var QUADS = {
    1: { name: '不做要出事', sub: '就在眼前，先解决' },
    2: { name: '抽时间做', sub: '不急，但真的重要' },
    3: { name: '能推就推', sub: '催得紧，没那么要紧' },
    4: { name: '可以不做', sub: '别为它占用脑子' }
  };

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function toStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var p = s.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return isNaN(d.getTime()) ? null : d;
  }
  function todayStr() { return toStr(new Date()); }
  function shiftDay(s, n) { var d = parseDate(s) || new Date(); d.setDate(d.getDate() + n); return toStr(d); }
  function diffDays(a, b) {
    var da = parseDate(a), db = parseDate(b);
    if (!da || !db) return 0;
    return Math.round((db.getTime() - da.getTime()) / 86400000);
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }

  var state = null;
  var loadedDate = todayStr();
  var saveChain = Promise.resolve();

  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var err = new Error(j.error || ('HTTP ' + r.status));
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }
  function setSaveState(text, bad) {
    var el = $('saveState');
    el.textContent = text;
    el.className = 'save-state' + (bad ? ' bad' : '');
  }
  function persist() {
    setSaveState('保存中…');
    saveChain = saveChain.then(function () {
      return api('POST', '/api/state', { state: state });
    }).then(function () {
      setSaveState('已保存');
    }).catch(function (e) {
      setSaveState('保存失败：' + e.message, true);
    });
    return saveChain;
  }
  function blankState() {
    return { version: 1, lastOpenDate: todayStr(), tasks: [], reminders: [], pendingReview: null };
  }

  function activeTasks() { return state.tasks.filter(function (t) { return t.status !== 'done'; }); }
  function findTask(id) { return state.tasks.filter(function (t) { return t.id === id; })[0]; }
  function setHistory(t, date, status) {
    var hit = t.history.filter(function (h) { return h.date === date; })[0];
    if (hit) hit.status = status;
    else t.history.push({ date: date, status: status });
  }

  function rollover(today) {
    var prev = state.lastOpenDate;
    if (!prev || prev === today) return;
    var gap = diffDays(prev, today);
    if (gap <= 0) { state.lastOpenDate = today; return; }
    var ids = [];
    state.tasks.forEach(function (t) {
      if (t.status === 'done' || t.createdDate > prev) return;
      ids.push(t.id);
      setHistory(t, prev, t.status);
      t.carryCount = (t.carryCount || 0) + gap;
      t.lastCarryDate = today;
      if (t.deadline && diffDays(t.deadline, today) > 0) t.quadrant = 1;
    });
    state.pendingReview = { date: prev, gap: gap, taskIds: ids };
    state.lastOpenDate = today;
  }

  function rebuildReminders() {
    var today = todayStr();
    var list = [];
    activeTasks().forEach(function (t) {
      var left = t.deadline ? -diffDays(t.deadline, today) : null;
      if (left !== null && left < 0) {
        list.push({ id: uid(), date: today, type: 'danger', tag: '过期了',
          text: '「' + t.title + '」已经过去 ' + (-left) + ' 天了。要么今天做，要么跟我说一声改到哪天。', taskId: t.id });
      } else if (left === 0) {
        list.push({ id: uid(), date: today, type: 'warn', tag: '就是今天',
          text: '「' + t.title + '」今天到期。现在做一点，晚上就不慌了。', taskId: t.id });
      } else if (left !== null && left <= 2 && t.quadrant === 2) {
        list.push({ id: uid(), date: today, type: 'tip', tag: '说一声',
          text: '「' + t.title + '」还有 ' + left + ' 天。今天花十分钟推一下，后面就轻松了。', taskId: t.id });
      }
      if ((t.carryCount || 0) >= 3) {
        list.push({ id: uid(), date: today, type: 'warn', tag: '总是推',
          text: '「' + t.title + '」你已经往后放了 ' + t.carryCount + ' 次。是不是该拆小点，或者干脆不做了？', taskId: t.id });
      }
      if (!t.deadline) {
        list.push({ id: uid(), date: today, type: 'tip', tag: '没定时间',
          text: '「' + t.title + '」还没定时间。你想哪天之前做完？', taskId: t.id });
      }
    });
    var actives = activeTasks();
    if (actives.length >= 3 && !actives.some(function (t) { return t.quadrant === 2; })) {
      list.push({ id: uid(), date: today, type: 'tip', tag: '说一句',
        text: '今天全是救火的活。有没有一件是「不急但真该做」的？给它留十分钟。', taskId: null });
    }
    state.reminders = state.reminders.filter(function (r) { return r.date !== today; }).concat(list);
  }

  function pickThree(today) {
    var list = activeTasks().slice();
    function score(t) {
      var left = t.deadline ? -diffDays(t.deadline, today) : 99;
      var s = 0;
      if (left < 0) s += 1000 + (-left) * 10;
      else if (left === 0) s += 900;
      else if (left === 1) s += 700;
      else if (left <= 3) s += 500;
      else if (left <= 7) s += 300;
      else s += 100;
      s += (5 - (t.quadrant || 2)) * 40;
      if (t.status === 'partial') s += 60;
      s += Math.min(t.carryCount || 0, 10) * 5;
      return s;
    }
    list.sort(function (a, b) { return score(b) - score(a); });
    return list.slice(0, 3);
  }
  function reasonFor(t, today) {
    var left = t.deadline ? -diffDays(t.deadline, today) : null;
    if (left !== null && left < 0) return '已经过去 ' + (-left) + ' 天了，今天得处理';
    if (left === 0) return '今天到期，早点做完踏实';
    if (left === 1) return '明天到期，今天先推一步';
    if (t.quadrant === 1) return '不做要出事，先解决它';
    if (t.quadrant === 2) return '不急，但真的重要，别再拖';
    if (t.quadrant === 3) return '催得急，顺手处理掉';
    return '空下来再说';
  }
  function renderFocus(today) {
    var three = pickThree(today);
    $('focusHint').textContent = three.length ? '从 ' + activeTasks().length + ' 件里挑的，先做这些' : '清单是空的';
    if (!three.length) {
      $('focusList').innerHTML = '<div class="empty">还没有任务。点右上角「加一件事」，说出来就行。</div>';
      return;
    }
    $('focusList').innerHTML = three.map(function (t, i) {
      return '<div class="focus-item">' +
        '<div class="focus-num">' + (i + 1) + '</div>' +
        '<div class="focus-body"><div class="focus-title">' + esc(t.title) + '</div>' +
        '<div class="focus-why">' + esc(reasonFor(t, today)) + '</div></div>' +
        '<button class="btn small primary" data-act="done" data-id="' + esc(t.id) + '">做完了</button>' +
        '</div>';
    }).join('');
  }

  function render() {
    var today = todayStr();
    var week = ['日', '一', '二', '三', '四', '五', '六'][new Date().getDay()];
    $('dateLine').innerHTML = esc(today) + '<span class="date-dot">·</span>星期' + week +
      '<span class="date-dot">·</span>' + activeTasks().length + ' 项待办';

    renderFocus(today);

    var rem = state.reminders.filter(function (r) { return r.date === today; });
    $('reminderCount').textContent = rem.length ? '(' + rem.length + ')' : '';
    $('reminderList').innerHTML = rem.length ? rem.map(function (r) {
      var btn = r.taskId ? '<button class="btn small ghost go" data-focus="' + esc(r.taskId) + '">定位</button>' : '';
      return '<div class="reminder ' + r.type + '"><span class="tag">' + esc(r.tag) + '</span><span>' + esc(r.text) + '</span>' + btn + '</div>';
    }).join('') : '<div class="empty">今天没有提醒。保持这个节奏。</div>';

    var html = '';
    for (var q = 1; q <= 4; q++) {
      var items = activeTasks().filter(function (t) { return t.quadrant === q; });
      html += '<section class="panel quad q' + q + '">';
      html += '<h2><span class="dot"></span>' + QUADS[q].name + '<span class="badge">' + items.length + '</span></h2>';
      html += '<div class="sub">' + QUADS[q].sub + '</div>';
      html += '<div class="tasks">';
      if (!items.length) {
        html += '<div class="quad-empty">这里还是空的</div>';
      } else {
        items.sort(function (a, b) { return (a.deadline || '9999').localeCompare(b.deadline || '9999'); });
        items.forEach(function (t) {
          var left = t.deadline ? -diffDays(t.deadline, today) : null;
          var overdue = left !== null && left < 0;
          var cls = 'task' + (overdue ? ' overdue' : '') + (t.status === 'partial' ? ' partial' : '');
          var badges = '';
          if (overdue) badges += '<span class="badge red">逾期 ' + (-left) + ' 天</span>';
          else if (left === 0) badges += '<span class="badge amber">今天截止</span>';
          else if (left !== null) badges += '<span class="badge">' + t.deadline + ' · 剩 ' + left + ' 天</span>';
          if ((t.carryCount || 0) > 0) badges += '<span class="badge amber">顺延 ' + t.carryCount + ' 次</span>';
          if (t.status === 'partial') badges += '<span class="badge blue">部分完成</span>';
          html += '<article class="' + cls + '" id="task-' + esc(t.id) + '">';
          html += '<div class="task-title">' + esc(t.title) + '</div>';
          if (t.note) html += '<div class="task-meta">' + esc(t.note) + '</div>';
          html += '<div class="task-meta">' + badges + '</div>';
          html += '<div class="task-actions">';
          html += '<select data-act="quad" data-id="' + esc(t.id) + '" aria-label="调整象限">';
          for (var k = 1; k <= 4; k++) {
            html += '<option value="' + k + '"' + (t.quadrant === k ? ' selected' : '') + '>' + QUADS[k].name + '</option>';
          }
          html += '</select>';
          html += '<input type="date" data-act="deadline" data-id="' + esc(t.id) + '" value="' + esc(t.deadline || '') + '" aria-label="修改截止日期">';
          html += '<button class="btn small" data-act="partial" data-id="' + esc(t.id) + '">部分完成</button>';
          html += '<button class="btn small" data-act="done" data-id="' + esc(t.id) + '">完成</button>';
          html += '<button class="btn small ghost" data-act="del" data-id="' + esc(t.id) + '">删除</button>';
          html += '</div></article>';
        });
      }
      html += '</div></section>';
    }
    $('matrix').innerHTML = html;

    var done = state.tasks.filter(function (t) { return t.status === 'done' && t.doneDate === today; });
    $('doneCount').textContent = done.length ? '(' + done.length + ')' : '';
    $('doneList').innerHTML = done.length ? done.map(function (t) {
      return '<div class="done-item"><span class="task-title done">' + esc(t.title) + '</span>' +
        '<button class="btn small ghost" data-act="undo" data-id="' + esc(t.id) + '">撤销</button></div>';
    }).join('') : '<div class="empty">今天还没有完成的任务。</div>';
  }

  function refresh() { rebuildReminders(); render(); persist(); }

  // 临近截止主动推送
  var pushKey = null;
  var pushSubscription = null;
  function setPushStatus(text, bad) {
    var el = $('pushStatus');
    el.textContent = text;
    el.className = 'save-state' + (bad ? ' bad' : '');
  }
  function urlB64ToBytes(value) {
    var padding = '='.repeat((4 - value.length % 4) % 4);
    var raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function updatePushButton() {
    $('pushEnableBtn').textContent = pushSubscription ? '关闭主动提醒' : '开启主动提醒';
  }
  function disablePushUI(reason) {
    setPushStatus(reason, true);
    $('pushEnableBtn').disabled = true;
    $('pushTestBtn').disabled = true;
  }
  function loadPushState() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      disablePushUI('当前浏览器不支持主动提醒');
      return;
    }
    api('GET', '/api/push/key').then(function (r) {
      if (!r.enabled || !r.publicKey) { disablePushUI('服务端推送未启用'); return; }
      pushKey = r.publicKey;
      return navigator.serviceWorker.register('/sw.js')
        .then(function () { return navigator.serviceWorker.ready; })
        .then(function (reg) { return reg.pushManager.getSubscription(); })
        .then(function (sub) {
          pushSubscription = sub;
          updatePushButton();
          setPushStatus(sub ? '已开启，临近截止会主动通知'
            : (Notification.permission === 'denied' ? '通知权限被拒绝，请在浏览器设置中开启' : '未开启'));
        });
    }).catch(function (e) { disablePushUI('推送初始化失败：' + e.message); });
  }
  function togglePush() {
    if (!pushKey) { setPushStatus('推送尚未就绪，请刷新重试', true); return; }
    if (pushSubscription) {
      var endpoint = pushSubscription.endpoint;
      pushSubscription.unsubscribe()
        .then(function () { return api('POST', '/api/push/unsubscribe', { endpoint: endpoint }); })
        .then(function () { pushSubscription = null; updatePushButton(); setPushStatus('已关闭'); })
        .catch(function (e) { setPushStatus('关闭失败：' + e.message, true); });
      return;
    }
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { setPushStatus('通知权限未授予', true); return; }
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToBytes(pushKey)
        });
      });
    }).then(function (sub) {
      if (!sub) return;
      return api('POST', '/api/push/subscribe', { subscription: sub.toJSON() }).then(function () {
        pushSubscription = sub;
        updatePushButton();
        setPushStatus('已开启，临近截止会主动通知');
      });
    }).catch(function (e) { setPushStatus('开启失败：' + e.message, true); });
  }
  function testPush() {
    $('pushTestBtn').disabled = true;
    api('POST', '/api/push/test')
      .then(function (r) { setPushStatus(r.message, !r.sent); })
      .catch(function (e) { setPushStatus('测试失败：' + e.message, true); })
      .then(function () { $('pushTestBtn').disabled = false; });
  }

  function loadWechatState() {
    api('GET', '/api/pushplus/status').then(function (r) {
      $('wechatState').textContent = r.configured ? ('已配置 · ' + r.channel) : '未配置';
      $('wxChannel').value = r.channel || 'wechat';
    }).catch(function () { $('wechatState').textContent = '读取配置失败'; });
  }
  function saveWechat() {
    var token = $('wxToken').value.trim();
    $('wxError').textContent = '';
    api('POST', '/api/pushplus/config', { token: token, channel: $('wxChannel').value })
      .then(function (r) {
        $('wxToken').value = '';
        loadWechatState();
        $('wxError').textContent = r.configured ? '已保存，token 不会回显。' : '已清空微信提醒配置。';
      })
      .catch(function (e) { $('wxError').textContent = e.message; });
  }
  function testWechat() {
    var btn = $('wxTest');
    btn.disabled = true;
    api('POST', '/api/pushplus/test')
      .then(function (r) { $('wxError').textContent = r.message; })
      .catch(function (e) { $('wxError').textContent = e.message; })
      .then(function () { btn.disabled = false; });
  }

  // 登录 / 注册
  var authMode = 'login';
  var authConfig = { emailRequired: true, emailVerified: false };
  api('GET', '/api/auth/config').then(function (r) { authConfig = r; setAuthMode(authMode); }).catch(function () {});
  var ACCOUNTS_KEY = 'dq_known_accounts';

  function knownAccounts() {
    try {
      var raw = localStorage.getItem(ACCOUNTS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(function (x) { return typeof x === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function rememberAccount(username) {
    if (!username) return;
    var arr = knownAccounts().filter(function (x) { return x !== username; });
    arr.unshift(username);
    try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(arr.slice(0, 8))); } catch (e) {}
    renderSavedAccounts();
  }
  function renderSavedAccounts() {
    var box = $('savedAccounts');
    var arr = knownAccounts();
    box.innerHTML = '';
    if (!arr.length) return;
    var label = document.createElement('span');
    label.className = 'u-label';
    label.style.cssText = 'font-size:12px;color:var(--muted);align-self:center';
    label.textContent = '这台设备用过：';
    box.appendChild(label);
    arr.forEach(function (name) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.onclick = function () { $('authUser').value = name; $('authError').textContent = ''; $('authPass').focus(); };
      box.appendChild(b);
    });
  }

  function setAuthMode(mode) {
    authMode = mode;
    $('tabLogin').classList.toggle('active', mode === 'login');
    $('tabRegister').classList.toggle('active', mode === 'register');
    $('tabReset').classList.toggle('active', mode === 'reset');
    $('authSubmit').textContent = mode === 'login' ? '登录' : (mode === 'register' ? '注册' : '重置密码');
    $('authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('authUser').closest('.field').classList.toggle('hidden', mode === 'reset');
    $('emailField').classList.toggle('hidden', mode === 'login');
    $('codeField').classList.toggle('hidden', mode === 'login');
    $('emailRequiredHint').textContent = authConfig.emailVerified ? '（必填，要收验证码）' : '（必填）';
    $('authPass').closest('.field').querySelector('label').childNodes[0].nodeValue = (mode === 'reset' ? '新密码' : '密码');
    $('authNote').textContent = mode === 'login'
      ? '账号名这台设备会替你记住，下次点一下就填好。忘记密码点上方「找回密码」。'
      : (mode === 'reset'
          ? '填注册时用的邮箱，收验证码后设置新密码。需要管理员已配置邮件服务。'
          : (authConfig.emailVerified
              ? '邮箱每个账号只能用一次，注册时要收一封验证码邮件。账号名随便起，这台设备会记住。'
              : '邮箱每个账号只能用一次，用来找回账号。管理员开启邮箱验证后，新注册要收验证码。'));
    $('authError').textContent = '';
  }
  $('tabLogin').onclick = function () { setAuthMode('login'); };
  $('tabRegister').onclick = function () { setAuthMode('register'); };
  $('tabReset').onclick = function () { setAuthMode('reset'); };

  $('togglePass').onclick = function () {
    var input = $('authPass');
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('togglePass').textContent = show ? '隐藏' : '显示';
  };

  var codeTimer = null;
  $('sendCodeBtn').onclick = function () {
    var email = $('authEmail').value.trim();
    $('authError').textContent = '';
    if (!email || email.indexOf('@') < 0) { $('authError').textContent = '先填邮箱，再发验证码。'; return; }
    var btn = $('sendCodeBtn');
    btn.disabled = true;
    api('POST', '/api/email/send-code', { email: email, purpose: authMode === 'reset' ? 'reset' : 'register' })
      .then(function (r) {
        var left = 60;
        btn.textContent = left + ' 秒后重发';
        codeTimer = setInterval(function () {
          left -= 1;
          if (left <= 0) { clearInterval(codeTimer); btn.disabled = false; btn.textContent = '重发验证码'; }
          else btn.textContent = left + ' 秒后重发';
        }, 1000);
        $('authCode').focus();
      })
      .catch(function (e) { $('authError').textContent = e.message; btn.disabled = false; });
  };

  $('authSubmit').onclick = function () {
    var username = $('authUser').value.trim();
    var password = $('authPass').value;
    var email = $('authEmail').value.trim();
    var code = $('authCode').value.trim();
    $('authError').textContent = '';
    if (authMode === 'reset') {
      if (!email || email.indexOf('@') < 0) { $('authError').textContent = '填注册时用的邮箱。'; return; }
      if (!code) { $('authError').textContent = '填邮箱收到的验证码。'; return; }
      if (!password) { $('authError').textContent = '填新密码。'; return; }
      $('authSubmit').disabled = true;
      api('POST', '/api/password/reset', { email: email, code: code, password: password })
        .then(function (r) {
          setAuthMode('login');
          $('authUser').value = '';
          $('authPass').value = '';
          $('authEmail').value = '';
          $('authCode').value = '';
          $('authError').style.color = 'var(--muted)';
          $('authError').textContent = r.message + '，现在用新密码登录。';
        })
        .catch(function (e) { $('authError').style.color = ''; $('authError').textContent = e.message; })
        .then(function () { $('authSubmit').disabled = false; });
      return;
    }
    if (!username || !password) { $('authError').textContent = '账号和密码都要填。'; return; }
    var payload = { username: username, password: password };
    if (authMode === 'register') {
      if (!email || email.indexOf('@') < 0) { $('authError').textContent = '请填有效邮箱——它是找回账号的唯一方式。'; return; }
      payload.email = email;
      if (authConfig.emailVerified) {
        if (!code) { $('authError').textContent = '填一下邮箱收到的验证码。'; return; }
        payload.code = code;
      }
    }
    $('authSubmit').disabled = true;
    api('POST', authMode === 'login' ? '/api/login' : '/api/register', payload)
      .then(function (r) {
        rememberAccount(r.username);
        $('authPass').value = '';
        $('authEmail').value = '';
        $('authCode').value = '';
        start(r.username, r.isAdmin);
      })
      .catch(function (e) {
        if (authMode === 'register' && e.status === 409) {
          $('authError').textContent = e.message + ' 如果是你之前注册的，切到「登录」直接进。';
          return;
        }
        $('authError').textContent = e.message;
      })
      .then(function () { $('authSubmit').disabled = false; });
  };
  $('authPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('authSubmit').click(); });

  setAuthMode('login');
  var lastAccount = knownAccounts()[0];
  if (lastAccount) $('authUser').value = lastAccount;
  renderSavedAccounts();

  $('logoutBtn').onclick = function () {
    api('POST', '/api/logout').then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
  };

  var isAdmin = false;
  function start(username, adminFlag) {
    isAdmin = !!adminFlag;
    $('authScreen').classList.add('hidden');
    $('appShell').classList.remove('hidden');
    $('whoAmI').textContent = username ? '(' + username + ')' : '';
    $('adminPanel').classList.toggle('hidden', !isAdmin);
    if (isAdmin) loadSmtpState();
    api('GET', '/api/state').then(function (r) {
      state = r.state && Array.isArray(r.state.tasks) ? r.state : blankState();
      loadedDate = todayStr();
      rollover(loadedDate);
      rebuildReminders();
      render();
      persist();
      loadPushState();
      loadWechatState();
      if (state.pendingReview && state.pendingReview.taskIds.length) setTimeout(openReview, 300);
    }).catch(function (e) {
      alert('读取任务失败：' + e.message);
    });
  }

  // 三步捕获向导：说出来 → 确认理解 → 两个小问题
  var draft = { title: '', deadline: '', impact: 2, urgency: 2 };
  function showWizardPage(n) {
    for (var i = 1; i <= 3; i++) {
      $('wzPage' + i).classList.toggle('hidden', i !== n);
      $('wzDot' + i).classList.toggle('active', i <= n);
      $('wzDot' + i).classList.toggle('done', i < n);
    }
  }
  $('addBtn').onclick = function () {
    draft = { title: '', deadline: '', impact: 2, urgency: 2 };
    $('wzInput').value = '';
    $('wzError1').textContent = '';
    $('wzError2').textContent = '';
    $('wzError3').textContent = '';
    showWizardPage(1);
    $('addMask').classList.add('show');
    setTimeout(function () { $('wzInput').focus(); }, 50);
  };
  document.querySelectorAll('.chip[data-sample]').forEach(function (btn) {
    btn.onclick = function () { $('wzInput').value = btn.getAttribute('data-sample'); $('wzInput').focus(); };
  });
  $('wzCancel1').onclick = function () { $('addMask').classList.remove('show'); };
  $('wzNext1').onclick = function () {
    var raw = $('wzInput').value.trim();
    if (!raw) { $('wzError1').textContent = '随便说一句就行，比如「明天交房租」。'; return; }
    var parsed = window.Capture.parse(raw);
    if (parsed.title.length < 2) { $('wzError1').textContent = '再多说几个字，我没听明白要做什么。'; return; }
    draft.title = parsed.title;
    draft.deadline = parsed.deadline || shiftDay(todayStr(), 3);
    $('wzTitle').value = draft.title;
    $('wzDatePreview').textContent = window.Capture.friendlyDate(draft.deadline);
    $('wzDate').value = draft.deadline;
    $('wzError2').textContent = parsed.matched ? '' : '没听出时间，我先放了三天后，你可以改。';
    showWizardPage(2);
  };
  $('wzBack2').onclick = function () { showWizardPage(1); };
  $('wzNext2').onclick = function () {
    var name = $('wzTitle').value.trim();
    if (name.length < 2) { $('wzError2').textContent = '写清楚要做什么，哪怕两三个字。'; return; }
    if (!$('wzDate').value) { $('wzError2').textContent = '定个日期吧，这样明天才能提醒你。'; return; }
    if (diffDays(todayStr(), $('wzDate').value) < 0) { $('wzError2').textContent = '日期不能早于今天。'; return; }
    draft.title = name;
    draft.deadline = $('wzDate').value;
    showWizardPage(3);
    updateWizardResult();
  };
  $('wzBack3').onclick = function () { showWizardPage(2); };
  ['qImpact', 'qUrgency'].forEach(function (id) {
    $(id).addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      Array.prototype.forEach.call($(id).querySelectorAll('button'), function (b) { b.classList.remove('sel'); });
      btn.classList.add('sel');
      updateWizardResult();
    });
  });
  function updateWizardResult() {
    var impact = $('qImpact').querySelector('.sel').getAttribute('data-v');
    var urgency = $('qUrgency').querySelector('.sel').getAttribute('data-v');
    var q = window.Capture.quadrant(impact, urgency, true);
    draft.impact = +impact; draft.urgency = +urgency; draft.quadrant = q;
    var names = { 1: '马上做', 2: '抽时间做', 3: '能推就推', 4: '可以不做' };
    var why = {
      1: '不做要出事，而且就在眼前。',
      2: '不做有麻烦，但不急在这一刻。',
      3: '催得紧，但其实没那么要紧。',
      4: '两头都不沾，先放到一边。'
    };
    $('wzResult').innerHTML = '<div class="wr-label">我打算把它放在</div><div class="wr-main">' + names[q] +
      '</div><div class="wr-why">' + why[q] + '</div>';
  }
  $('wzSave').onclick = function () {
    if (!draft.title || !draft.deadline) { $('wzError3').textContent = '前面的信息没了，请从头再来一次。'; return; }
    state.tasks.push({
      id: uid(), title: draft.title, note: '',
      quadrant: draft.quadrant || 2, deadline: draft.deadline,
      createdDate: todayStr(), status: 'pending', statusDate: null,
      carryCount: 0, lastCarryDate: null, history: [], doneDate: null,
      why: { impact: draft.impact, urgency: draft.urgency }
    });
    $('addMask').classList.remove('show');
    refresh();
  };
  $('addMask').addEventListener('click', function (e) {
    if (e.target === $('addMask')) $('addMask').classList.remove('show');
  });

  // 任务卡片操作
  document.addEventListener('click', function (e) {
    var focus = e.target.getAttribute && e.target.getAttribute('data-focus');
    if (focus) {
      var el = $('task-' + focus);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.outline = '2px solid #2563eb';
        setTimeout(function () { el.style.outline = ''; }, 1800);
      }
      return;
    }
    var id = e.target.getAttribute && e.target.getAttribute('data-id');
    var act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (!id || !act) return;
    var t = findTask(id);
    if (!t) return;
    if (act === 'done' || act === 'undo') {
      var done = act === 'done';
      t.status = done ? 'done' : 'pending';
      t.statusDate = todayStr();
      t.doneDate = done ? todayStr() : null;
      setHistory(t, todayStr(), t.status);
      if (state.pendingReview) state.pendingReview.taskIds = state.pendingReview.taskIds.filter(function (x) { return x !== id; });
      refresh();
    } else if (act === 'partial') {
      t.status = t.status === 'partial' ? 'pending' : 'partial';
      t.statusDate = todayStr();
      setHistory(t, todayStr(), t.status);
      refresh();
    } else if (act === 'del') {
      if (!confirm('确认删除「' + t.title + '」？删除后无法恢复。')) return;
      state.tasks = state.tasks.filter(function (x) { return x.id !== id; });
      refresh();
    }
  });
  document.addEventListener('change', function (e) {
    var id = e.target.getAttribute && e.target.getAttribute('data-id');
    var act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (!id || !act) return;
    var t = findTask(id);
    if (!t) return;
    if (act === 'quad') { t.quadrant = +e.target.value; refresh(); }
    if (act === 'deadline') {
      if (!e.target.value) { alert('截止日期不能为空。想取消请删除任务。'); render(); return; }
      t.deadline = e.target.value;
      if (diffDays(t.deadline, todayStr()) > 0) t.quadrant = 1;
      refresh();
    }
  });

  // 回顾
  var reviewDraft = {};
  function openReview() {
    var pr = state.pendingReview;
    var date = pr ? pr.date : todayStr();
    var ids = pr ? pr.taskIds.filter(function (id) { return !!findTask(id); }) :
      activeTasks().filter(function (t) { return t.createdDate <= date; }).map(function (t) { return t.id; });
    if (!ids.length) { alert('没有需要回顾的任务。'); return; }
    reviewDraft = {};
    ids.forEach(function (id) {
      var t = findTask(id);
      reviewDraft[id] = { status: t.status === 'done' ? 'done' : t.status, deadline: t.deadline };
    });
    $('reviewTitle').textContent = pr ? '上次回顾 · ' + date : '今日回顾 · ' + date;
    $('reviewDesc').textContent = pr ?
      ('距离上次打开过了 ' + pr.gap + ' 天。下面这些任务当时未完成，请补上结果和截止日期。') :
      '逐条确认今天的完成情况；没定截止日期的，现在补上。';
    $('reviewError').textContent = '';
    $('reviewItems').innerHTML = ids.map(function (id) {
      var t = findTask(id);
      var d = reviewDraft[id];
      return '<div class="review-item"><div class="rt">' + esc(t.title) + '</div><div class="rrow">' +
        '<span>完成情况：</span><span class="seg" data-seg="' + esc(id) + '">' +
        ['pending', 'partial', 'done'].map(function (s) {
          var label = { pending: '未完成', partial: '部分完成', done: '已完成' }[s];
          return '<button type="button" data-val="' + s + '" class="' + (d.status === s ? 'active' : '') + '">' + label + '</button>';
        }).join('') + '</span>' +
        '<label>截止日期 <input type="date" data-review-date="' + esc(id) + '" value="' + esc(d.deadline || '') + '"></label>' +
        '</div></div>';
    }).join('');
    $('reviewMask').classList.add('show');
  }
  $('reviewBtn').onclick = openReview;
  $('reviewCancel').onclick = function () { $('reviewMask').classList.remove('show'); };
  $('reviewItems').addEventListener('click', function (e) {
    var val = e.target.getAttribute && e.target.getAttribute('data-val');
    if (!val) return;
    var seg = e.target.closest('[data-seg]');
    if (!seg) return;
    var id = seg.getAttribute('data-seg');
    reviewDraft[id].status = val;
    Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-val') === val);
    });
  });
  $('reviewItems').addEventListener('change', function (e) {
    var id = e.target.getAttribute && e.target.getAttribute('data-review-date');
    if (id) reviewDraft[id].deadline = e.target.value;
  });
  $('reviewSave').onclick = function () {
    var reviewDate = state.pendingReview ? state.pendingReview.date : todayStr();
    var ids = Object.keys(reviewDraft);
    for (var i = 0; i < ids.length; i++) {
      var d = reviewDraft[ids[i]];
      if (!d.deadline) { $('reviewError').textContent = '每个任务都要有截止日期，请补全。'; return; }
      if (diffDays(todayStr(), d.deadline) < 0) { $('reviewError').textContent = '截止日期不能早于今天。'; return; }
    }
    ids.forEach(function (id) {
      var t = findTask(id), d = reviewDraft[id];
      t.deadline = d.deadline;
      t.status = d.status;
      t.statusDate = todayStr();
      t.doneDate = d.status === 'done' ? todayStr() : null;
      if (diffDays(d.deadline, todayStr()) > 0) t.quadrant = 1;
      setHistory(t, reviewDate, d.status);
    });
    state.pendingReview = null;
    $('reviewMask').classList.remove('show');
    refresh();
  };

  // 导出 / 导入
  $('exportBtn').onclick = function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '四象限备份-' + todayStr() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };
  $('importBtn').onclick = function () { $('importFile').click(); };
  $('importFile').onchange = function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var s = JSON.parse(reader.result);
        if (!s || s.version !== 1 || !Array.isArray(s.tasks)) throw new Error('bad');
        if (!confirm('导入会覆盖当前所有数据，确认继续？')) return;
        state = s;
        if (!Array.isArray(state.reminders)) state.reminders = [];
        state.tasks.forEach(function (t) { if (!Array.isArray(t.history)) t.history = []; });
        render();
        persist();
        alert('导入完成。');
      } catch (err) { alert('文件格式不对，导入失败。'); }
    };
    reader.readAsText(f);
    e.target.value = '';
  };

  $('guideHead').onclick = function () { $('guide').classList.toggle('collapsed'); };

  $('refreshBtn').onclick = refresh;
  $('pushEnableBtn').onclick = togglePush;
  $('pushTestBtn').onclick = testPush;
  $('wxSave').onclick = saveWechat;
  $('wxTest').onclick = testWechat;

  function loadSmtpState() {
    api('GET', '/api/admin/smtp').then(function (r) {
      $('smtpHost').value = r.host || '';
      $('smtpPort').value = r.port || '465';
      $('smtpUser').value = r.user || '';
      $('smtpSender').value = r.sender || '';
      $('smtpState').textContent = r.configured ? '已开启邮箱验证' : '邮箱验证未开启';
    }).catch(function (e) { $('smtpError').textContent = e.message; });
  }
  $('smtpSave').onclick = function () {
    $('smtpError').textContent = '';
    $('smtpSave').disabled = true;
    api('POST', '/api/admin/smtp', {
      host: $('smtpHost').value.trim(), port: $('smtpPort').value.trim(),
      user: $('smtpUser').value.trim(), password: $('smtpPass').value.trim(),
      sender: $('smtpSender').value.trim()
    }).then(function (r) {
      $('smtpPass').value = '';
      $('smtpState').textContent = '已开启邮箱验证';
      $('smtpError').style.color = 'var(--muted)';
      $('smtpError').textContent = r.message;
      authConfig.emailVerified = true;
    }).catch(function (e) { $('smtpError').style.color = ''; $('smtpError').textContent = e.message; })
      .then(function () { $('smtpSave').disabled = false; });
  };
  $('smtpTest').onclick = function () {
    $('smtpError').textContent = '';
    api('POST', '/api/admin/smtp/test').then(function (r) {
      $('smtpError').style.color = 'var(--muted)';
      $('smtpError').textContent = r.message;
    }).catch(function (e) { $('smtpError').style.color = ''; $('smtpError').textContent = e.message; });
  };

  $('addMask').addEventListener('click', function (e) { if (e.target === $('addMask')) $('addMask').classList.remove('show'); });
  $('reviewMask').addEventListener('click', function (e) { if (e.target === $('reviewMask')) $('reviewMask').classList.remove('show'); });

  setInterval(function () {
    if (!state || document.getElementById('appShell').classList.contains('hidden')) return;
    if (todayStr() !== loadedDate) {
      loadedDate = todayStr();
      rollover(loadedDate);
      refresh();
      if (state.pendingReview && state.pendingReview.taskIds.length) openReview();
    }
  }, 60000);

  api('GET', '/api/me').then(function (r) {
    if (r.authenticated) start(r.username, r.isAdmin);
    else $('authScreen').classList.remove('hidden');
  }).catch(function () {
    $('authError').textContent = '连不上服务器，请刷新重试。';
  });
})();
