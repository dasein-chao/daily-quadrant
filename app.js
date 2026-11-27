(function () {
  'use strict';

  // 出错就把话说在页面上，别让用户对着一个没反应的按钮猜
  window.onerror = function (msg, src, line) {
    try {
      var bar = document.getElementById('errBar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'errBar';
        bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;' +
          'background:#b91c1c;color:#fff;font:13px/1.6 system-ui;padding:8px 12px;' +
          'white-space:pre-wrap;word-break:break-all';
        document.body.appendChild(bar);
      }
      bar.textContent = '页面出错，请把这张截图发给开发：' + msg + '（第 ' + line + ' 行）';
    } catch (e) {}
    return false;
  };

  // 3×3 九格：编号 = 重要档*3 + 紧急档 + 1，9 最高优先级
  var QUADS = {
    9: { name: '立刻解决', sub: '崩溃的前兆之一，就是相信这活非你不可（罗素）' },
    8: { name: '尽快处理', sub: '明天只是今天的继续，还带着今天的委屈（老舍）' },
    7: { name: '排进计划', sub: '决定了，应当劳动。第二天：很累，不想劳动了（托尔斯泰）' },
    6: { name: '先做掉', sub: '催得紧。办了它，世界就清净一小会儿' },
    5: { name: '看着办', sub: '我也拿不准，看今天心情吧' },
    4: { name: '抽空弄', sub: '你想干什么？我想游手好闲（毛姆）' },
    3: { name: '顺手做', sub: '事不大，但毕竟是事，随手打发掉（契诃夫）' },
    2: { name: '能推就推', sub: '我认为推一推是合法的（化用契诃夫）' },
    1: { name: '可以不做', sub: '事已至此，先吃饭吧。天塌了也别忘了吃饭' }
  };
  // 老数据 quadrant 1-4 → 新 9 格映射（旧 1 最高，新 9 最高）
  var OLD_QUAD_MAP = { 1: 9, 2: 7, 3: 3, 4: 1 };

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
  var currentUsername = '';
  var isGuest = false;
  var loadedDate = todayStr();
  var GUEST_KEY = 'dq_guest_state';
  var GUEST_FLAG = 'dq_guest_mode';

  function readGuestState() {
    try { return JSON.parse(localStorage.getItem(GUEST_KEY) || 'null'); } catch (e) { return null; }
  }
  function guestModeOn() { try { return localStorage.getItem(GUEST_FLAG) === '1'; } catch (e) { return false; } }
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
    if (isGuest) {
      try { localStorage.setItem(GUEST_KEY, JSON.stringify(state)); setSaveState('已存在本机'); }
      catch (e) { setSaveState('本机存储失败', true); }
      return;
    }
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
  // 老数据或半截数据缺字段，统一补齐，避免 .filter 崩
  function normalizeState(s) {
    var out = s && typeof s === 'object' ? s : {};
    out.version = 1;
    if (!Array.isArray(out.tasks)) out.tasks = [];
    if (!Array.isArray(out.reminders)) out.reminders = [];
    if (!out.pendingReview || !Array.isArray(out.pendingReview.taskIds)) out.pendingReview = null;
    if (!out.lastOpenDate) out.lastOpenDate = todayStr();
    out.tasks.forEach(function (t) {
      if (!Array.isArray(t.history)) t.history = [];
      var q = +t.quadrant;
      if (OLD_QUAD_MAP[q] && !(t.why && t.why.impact)) t.quadrant = OLD_QUAD_MAP[q];
      if (!(t.quadrant >= 1 && t.quadrant <= 9)) t.quadrant = 5;
      if (!t.why) t.why = {};
      if (!(t.why.effort >= 1 && t.why.effort <= 5)) t.why.effort = 3;
      // 时间必须是合法的 HH:MM，脏值直接清掉，别显示成「25:99 到点」
      if (t.time) {
        var mt = String(t.time).match(/^(\d{1,2}):(\d{2})$/);
        if (!mt || +mt[1] > 23 || +mt[2] > 59) t.time = '';
        else t.time = ('0' + mt[1]).slice(-2) + ':' + mt[2];
      }
    });
    return out;
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
      if (t.deadline && diffDays(t.deadline, today) > 0) t.quadrant = 9;
    });
    state.pendingReview = { date: prev, gap: gap, taskIds: ids };
    state.lastOpenDate = today;
  }

  function rebuildReminders() {
    var today = todayStr();
    var list = [];
    var pastList = [];      // 今天已经过点的任务，攒起来合并成一条
    activeTasks().forEach(function (t) {
      var left = t.deadline ? -diffDays(t.deadline, today) : null;
      if (left !== null && left < 0) {
        list.push({ id: uid(), date: today, type: 'danger', tag: '过期了',
          text: '「' + t.title + '」欠了 ' + (-left) + ' 天。钱可以欠，事欠着心里不踏实。', taskId: t.id });
      } else if (left === 0) {
        var todayMsg;
        if (t.time) {
          // 有具体钟点：说清几点、过了没有；窗口按难度走
          var nowMin = new Date().getHours() * 60 + new Date().getMinutes();
          var parts = String(t.time).split(':');
          var dueMin = (+parts[0]) * 60 + (+parts[1] || 0);
          var eff = (t.why && t.why.effort) || 3;
          // 提前量与后端一致：难度打底 + 重要度加权
          var baseLead = { 1: 5, 2: 15, 3: 25, 4: 35, 5: 45 }[eff] || 25;
          var bonusLead = { 9: 15, 8: 10, 7: 5, 6: 3 }[(t.quadrant || 5)] || 0;
          var lead = Math.min(baseLead + bonusLead, 60);
          var away = dueMin - nowMin;
          if (nowMin > dueMin && dueMin > 0) {
            pastList.push(t.time + ' ' + t.title);
            return;             // 先攒着，最后合并成一条
          } else if (away >= 0 && away <= lead) {
            var awayTxt = away >= 60 ? (Math.floor(away / 60) + ' 小时' + (away % 60 ? ' ' + (away % 60) + ' 分钟' : '')) : (away + ' 分钟');
            todayMsg = '「' + t.title + '」' + t.time + ' 就要到了，还有 ' + awayTxt +
              (eff >= 4 ? '。这活儿费神，手头别的先放一放。' : '。');
          } else {
            todayMsg = '「' + t.title + '」今天 ' + t.time + '。还早，但别忘。';
          }
        } else {
          todayMsg = '「' + t.title + '」今日到期。先动一动手，剩下的交给明天。';
        }
        list.push({ id: uid(), date: today, type: 'warn', tag: t.time ? (t.time + ' 到点') : '就是今天',
          text: todayMsg, taskId: t.id });
      } else if (left !== null && left <= 2 && t.quadrant >= 7) {
        list.push({ id: uid(), date: today, type: 'tip', tag: '说一声',
          text: '「' + t.title + '」还有 ' + left + ' 天。不着急，但也别装忘。', taskId: t.id });
      }
      if ((t.carryCount || 0) >= 3) {
        list.push({ id: uid(), date: today, type: 'warn', tag: '总是推',
          text: '「' + t.title + '」已经推了 ' + t.carryCount + ' 回。它大概也累了，要么拆小，要么放它走。', taskId: t.id });
      }
      if (!t.deadline) {
        list.push({ id: uid(), date: today, type: 'tip', tag: '没定时间',
          text: '「' + t.title + '」没定日子。不定也行，就是会一直惦记。', taskId: t.id });
      }
    });
    var actives = activeTasks();
    if (actives.length >= 3 && !actives.some(function (t) { return t.quadrant >= 7; })) {
      list.push({ id: uid(), date: today, type: 'tip', tag: '说一句',
        text: '今天全是救火的活。救到最后常常一场空——挑一件不急但要紧的，留十分钟。', taskId: null });
    }
    if (pastList.length) {
      var pText = pastList.length === 1
        ? '「' + pastList[0] + '」过点了。做了就划掉，没做就改个时间。'
        : pastList.join('、') + '，都过点了。做了就划掉，没做就改个时间。';
      list.push({ id: uid(), date: today, type: 'warn', tag: '过点了', text: pText, taskId: null });
    }

    state.reminders = state.reminders.filter(function (r) { return r.date !== today; }).concat(list);
  }

  function isQuickTask(t) {
    var effort = (t.why && t.why.effort) || 3;
    if (effort > 2) return false;
    // 只有"不重要"的顺手事才进这里。「交房租」难度低但重要，仍归正事
    if ((t.quadrant || 5) > 6) return false;
    if (t.deadline && -diffDays(t.deadline, todayStr()) < 0) return false;
    return true;
  }
  function pickThree(today) {
    // 举手之劳的事进「顺手清掉」，不占今天三件的名额
    var list = activeTasks().filter(function (t) { return !isQuickTask(t); });
    function score(t) {
      var left = t.deadline ? -diffDays(t.deadline, today) : 99;
      var s = 0;
      // 逾期加分封顶：拖再久也不该永远压在今天的正事前面
      if (left < 0) s += 1000 + Math.min(-left, 5) * 10;
      else if (left === 0) {
        s += 900;
        // 今天且定了具体钟点：到点就得在场，比陈年逾期更硬
        if (t.time) s += 250;
      }
      else if (left === 1) s += 700;
      else if (left <= 3) s += 500;
      else if (left <= 7) s += 300;
      else s += 100;
      s += (t.quadrant || 5) * 40;
      // 难度只微调先后：举手之劳上浮，大工程略降，不改变象限
      var effort = (t.why && t.why.effort) || 3;
      s += (4 - effort) * 12;
      if (t.status === 'partial') s += 60;
      s += Math.min(t.carryCount || 0, 10) * 5;
      return s;
    }
    list.sort(function (a, b) { return score(b) - score(a); });
    return list.slice(0, 3);
  }
  // 按任务类型给一句关心，别全是同一个腔调
  var TYPE_CARE = [
    { re: /买|购|下单|挑|订|置办/, care: '买之前想一眼用在哪，能立刻用上就现在就买' },
    { re: /写|改|稿|报告|论文|方案|总结|文档/, care: '先写下最难的那一句，剩下的会自己接上来' },
    { re: /学|读|看|背|练|听课|复习|刷题/, care: '别求一次学完，先专注二十分钟就够' },
    { re: /约|联系|问|聊|沟通|电话|回复|回信/, care: '对方也在等你，一句话就能推进' },
    { re: /交|提交|上传|报名|申请|寄|送/, care: '交了才算完，别卡在最后一厘米' },
    { re: /修|装|整理|打扫|收拾|洗|搬/, care: '动起手来比想快，先做五分钟' },
    { re: /开会|会|面试|汇报|答辩/, care: '准备三句话就够开场，剩下的现场能接' }
  ];
  function careFor(t) {
    var title = String(t.title || '');
    for (var i = 0; i < TYPE_CARE.length; i++) {
      if (TYPE_CARE[i].re.test(title)) return TYPE_CARE[i].care;
    }
    return '';
  }
  // 和后端一致：按难度+重要度算提前量，再按队列错峰，得出"每条会在几点提醒"
  var LEAD_BY_EFFORT = { 1: 5, 2: 15, 3: 25, 4: 35, 5: 45 };
  var LEAD_BONUS_QUAD = { 9: 15, 8: 10, 7: 5, 6: 3 };
  var MIN_GAP = 10;

  function leadFor(t) {
    var e = (t.why && t.why.effort) || 3;
    var q = t.quadrant || 5;
    return Math.min((LEAD_BY_EFFORT[e] || 25) + (LEAD_BONUS_QUAD[q] || 0), 60);
  }

  // 返回 { taskId: {label, state} }：state = 'upcoming' | 'past' | 'early'
  // 和后端同一套：难度+重要度算提前量，排队错峰，早于 6 点的挪到前一晚 21:00
  function planReminders() {
    var today = todayStr();
    var tomorrow = shiftDay(today, 1);
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var list = activeTasks().filter(function (t) {
      return t.time && (t.deadline === today || t.deadline === tomorrow);
    });

    var items = list.map(function (t) {
      var p = String(t.time).split(':');
      var dueMin = (+p[0]) * 60 + (+p[1] || 0);
      var lead = leadFor(t);
      var notifyMin = dueMin - lead;
      var isTomorrow = t.deadline === tomorrow;
      var prevEvening = false;
      if (notifyMin < 360) { notifyMin = 21 * 60; prevEvening = true; }
      return { t: t, dueMin: dueMin, notifyMin: notifyMin, isTomorrow: isTomorrow, prevEvening: prevEvening, lead: lead };
    });

    // 只给"今天"排队；明天的单独算，避免跨天错峰算乱
    var todays = items.filter(function (it) { return !it.isTomorrow; });
    todays.sort(function (a, b) {
      if (a.notifyMin !== b.notifyMin) return a.notifyMin - b.notifyMin;
      return a.dueMin - b.dueMin;
    });
    var last = null;
    todays.forEach(function (it) {
      if (last !== null) {
        var earliest = last + MIN_GAP;
        if (it.notifyMin < earliest) {
          var latest = it.dueMin - 5;
          it.notifyMin = latest > last ? Math.min(earliest, latest) : latest;
        }
      }
      last = it.notifyMin;
    });

    var map = {};
    items.forEach(function (it) {
      var m = ((it.notifyMin % 1440) + 1440) % 1440;
      var h = Math.floor(m / 60), mm = m % 60;
      var hhmm = (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;

      if (it.isTomorrow) {
        // 按钟点说人话：上午说「明早」，午后说「明天」，傍晚后说「明晚」
        var dayWord = it.prevEvening ? '今晚 ' : (h < 11 ? '明早 ' : (h < 18 ? '明天 ' : '明晚 '));
        map[it.t.id] = { label: dayWord + hhmm + ' 提醒', state: it.prevEvening ? 'tonight' : 'tomorrow' };
        return;
      }
      // 今天：事情本身已经过去，直接说已过点，别再承诺任何"提醒"
      if (nowMin > it.dueMin) {
        map[it.t.id] = { label: '已过点', state: 'past' };
      } else if (it.prevEvening) {
        map[it.t.id] = { label: '前一晚 21:00 提醒', state: 'early' };
      } else if (nowMin >= it.notifyMin) {
        map[it.t.id] = { label: '已提醒 · ' + hhmm, state: 'notified' };
      } else {
        map[it.t.id] = { label: hhmm + ' 提醒', state: 'upcoming' };
      }
    });
    return map;
  }

  function reasonFor(t, today) {
    var left = t.deadline ? -diffDays(t.deadline, today) : null;
    if (left !== null && left < 0) return '已经过去 ' + (-left) + ' 天了，今天得处理';
    if (left === 0) return '今天到期，早点做完踏实';
    if (t.quadrant >= 8) return '不做要出事，先解决它';
    if (left === 1) return '明天到期，今天先推一步';
    var care = careFor(t);
    if (care) return care;
    if (t.quadrant >= 6) return '挺重要，今天推一下';
    if (t.quadrant >= 4) return '有空就做，别一直拖';
    return '空下来再说';
  }
  function renderFocus(today) {
    var three = pickThree(today);
    $('focusHint').textContent = three.length ? '从 ' + activeTasks().length + ' 件里挑的，先对付这些' : '今天没有非做不可的';
    if (!three.length) {
      $('focusList').innerHTML = '<div class="empty">今天没事。这种日子不多，享受一下。想起来了点右上角说一句。</div>';
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

  function renderQuick() {
    var quick = activeTasks().filter(isQuickTask);
    $('quickPanel').classList.toggle('hidden', quick.length === 0);
    $('quickCount').textContent = quick.length;
    $('quickList').innerHTML = quick.map(function (t) {
      return '<div class="focus-item quick-item">' +
        '<div class="focus-body"><div class="focus-title">' + esc(t.title) + '</div>' +
        '<div class="focus-why">举手之劳 · 做完就忘了它</div></div>' +
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
    renderQuick();

    var rem = state.reminders.filter(function (r) { return r.date === today; });
    $('reminderCount').textContent = rem.length ? '(' + rem.length + ')' : '';
    $('reminderList').innerHTML = rem.length ? rem.map(function (r) {
      var btn = r.taskId ? '<button class="btn small ghost go" data-focus="' + esc(r.taskId) + '">定位</button>' : '';
      return '<div class="reminder ' + r.type + '"><span class="tag">' + esc(r.tag) + '</span><span>' + esc(r.text) + '</span>' + btn + '</div>';
    }).join('') : '<div class="empty">今天没有提醒。什么都不想做，就在床上懒着。</div>';

    var reminderPlan = planReminders();
    var html = '';
    for (var q = 9; q >= 1; q--) {
      var items = activeTasks().filter(function (t) { return t.quadrant === q; });
      html += '<section class="panel quad q' + q + '">';
      html += '<h2><span class="dot"></span>' + QUADS[q].name + '<span class="badge">' + items.length + '</span></h2>';
      html += '<div class="sub">' + QUADS[q].sub + '</div>';
      html += '<div class="tasks">';
      if (!items.length) {
        html += '<div class="quad-empty">此处清白，尚无俗事</div>';
      } else {
        items.sort(function (a, b) { return (a.deadline || '9999').localeCompare(b.deadline || '9999'); });
        items.forEach(function (t) {
          var left = t.deadline ? -diffDays(t.deadline, today) : null;
          var overdue = left !== null && left < 0;
          var cls = 'task' + (overdue ? ' overdue' : '') + (t.status === 'partial' ? ' partial' : '');
          var badges = '';
          var timeTag = t.time ? ' ' + t.time : '';
          var timeTag = t.time ? ' ' + t.time : '';
          if (overdue) badges += '<span class="badge red">逾期 ' + (-left) + ' 天' + timeTag + '</span>';
          else if (left === 0) badges += '<span class="badge amber">今天截止' + timeTag + '</span>';
          else if (left !== null) badges += '<span class="badge">' + t.deadline + timeTag + ' · 剩 ' + left + ' 天</span>';
          // 有钟点的任务，明确告诉用户"几点会提醒你"，别让规划成黑箱
          var rp = reminderPlan[t.id];
          if (t.time && rp) {
            var rpCls = (rp.state === 'past' || rp.state === 'notified') ? ' class="badge muted"' : ' class="badge"';
            badges += '<span' + rpCls + '>' + rp.label + '</span>';
          }
          if ((t.carryCount || 0) > 0) badges += '<span class="badge amber">顺延 ' + t.carryCount + ' 次</span>';
          if (t.status === 'partial') badges += '<span class="badge blue">部分完成</span>';
          html += '<article class="' + cls + '" id="task-' + esc(t.id) + '">';
          html += '<div class="task-title">' + esc(t.title) + '</div>';
          if (t.note) html += '<div class="task-meta">' + esc(t.note) + '</div>';
          html += '<div class="task-meta">' + badges + '</div>';
          html += '<div class="task-actions">';
          html += '<select data-act="quad" data-id="' + esc(t.id) + '" aria-label="调整象限">';
          for (var k = 9; k >= 1; k--) {
            html += '<option value="' + k + '"' + (t.quadrant === k ? ' selected' : '') + '>' + QUADS[k].name + '</option>';
          }
          html += '</select>';
          html += '<input type="date" data-act="deadline" data-id="' + esc(t.id) + '" value="' + esc(t.deadline || '') + '" aria-label="修改截止日期">';
          html += '<input type="text" inputmode="numeric" maxlength="5" placeholder="14:00" data-act="time" data-id="' + esc(t.id) + '" value="' + esc(t.time || '') + '" aria-label="修改时间，如 14:00，留空则只按天提醒" class="time-input">';
          html += '<button class="btn small" data-act="partial" data-id="' + esc(t.id) + '">部分完成</button>';
          html += '<button class="btn small" data-act="done" data-id="' + esc(t.id) + '">完成</button>';
          html += '<button class="btn small ghost del-btn" data-act="del" data-id="' + esc(t.id) + '">删除</button>';
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
    }).join('') : '<div class="empty">今天还没做成什么。什么都不想做，就在床上懒着。</div>';
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
      $('wxChannel').value = r.channel || 'wechat';
    }).catch(function () {});
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
    $('codeField').classList.toggle('hidden', mode !== 'register' || !authConfig.emailVerified);
    $('emailRequiredHint').textContent = authConfig.emailVerified ? '（必填，要收验证码）' : '（必填）';
    $('authPass').closest('.field').querySelector('label').childNodes[0].nodeValue = (mode === 'reset' ? '新密码' : '密码');
    $('authNote').textContent = mode === 'login'
      ? '账号名这台设备会替你记住，下次点一下就填好。忘记密码点上方「找回密码」。'
      : (mode === 'reset'
          ? '填注册时用的邮箱，收验证码后设置新密码。需要管理员已配置邮件服务。'
          : (authConfig.emailVerified
              ? '邮箱每个账号只能用一次，注册时要收一封验证码邮件。账号名随便起，这台设备会记住。收不到验证码就先游客用，之后注册能把记下的事一起并进账号。'
              : '邮箱每个账号只能用一次，只用来找回密码。注册不用等验证码，填完直接进。账号名随便起，这台设备会记住。'));
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
        // 邮件服务没配好、验证码发不出时，注册就走不通——给一条不堵死的路
        $('authError').textContent = authMode === 'register'
          ? e.message + '（注册暂时走不通的话，先点下面「先不注册，游客用一下」，之后注册能把这几件事并进账号。）'
          : e.message;
      })
      .then(function () { $('authSubmit').disabled = false; });
  };
  $('authPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('authSubmit').click(); });

  $('guestBtn').onclick = function () { startGuest(); };
  $('guestRegisterBtn').onclick = function () {
    isGuest = false;
    $('appShell').classList.add('hidden');
    $('authScreen').classList.remove('hidden');
    setAuthMode('register');
  };

  setAuthMode('login');
  if (guestModeOn()) startGuest();
  var lastAccount = knownAccounts()[0];
  if (lastAccount) $('authUser').value = lastAccount;
  renderSavedAccounts();

  $('logoutBtn').onclick = function () {
    if (isGuest) {
      var g = readGuestState();
      var n = g && Array.isArray(g.tasks) ? g.tasks.length : 0;
      // 退出就把本机游客数据清掉，必须问一声，别让人一键清空
      if (!confirm((n ? '这台设备上还存着 ' + n + ' 件事。' : '')
          + '退出会清掉游客数据，清掉就找不回来。\n\n想留着就先「注册长期用」，注册时能并进账号。确定退出吗？')) return;
      try { localStorage.removeItem(GUEST_FLAG); localStorage.removeItem(GUEST_KEY); } catch (e) {}
      location.reload();
      return;
    }
    api('POST', '/api/logout').then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
  };

  var isAdmin = false;
  function enterApp() {
    $('authScreen').classList.add('hidden');
    $('appShell').classList.remove('hidden');
    $('adminPanel').classList.toggle('hidden', !isAdmin);
    $('reminderOpenBtn').classList.toggle('hidden', isGuest);
    if (isAdmin) loadSmtpState();
    loadedDate = todayStr();
    rollover(loadedDate);
    rebuildReminders();
    render();
    persist();
    if (!isGuest) {
      loadPushState();
      loadWechatState();
      loadReminderMode();
    }
    if (state.pendingReview && state.pendingReview.taskIds.length) setTimeout(openReview, 300);
  }
  function start(username, adminFlag) {
    isGuest = false;
    try { localStorage.removeItem(GUEST_FLAG); } catch (e) {}
    currentUsername = username || '';
    isAdmin = !!adminFlag;
    $('whoAmI').textContent = username ? '(' + username + ')' : '';
    $('guestBadge').classList.add('hidden');
    $('guestUpgrade').classList.add('hidden');
    api('GET', '/api/state').then(function (r) {
      state = normalizeState(r.state);
      enterApp();
      mergeGuestState(username || '这个账号');
    }).catch(function (e) {
      alert('读取任务失败：' + e.message);
    });
  }
  // 游客记过的事，注册/登录后并进账号——不能让用户白记一遍
  function mergeGuestState(username) {
    var g = readGuestState();
    if (!g || !Array.isArray(g.tasks) || !g.tasks.length) return;
    var guestTasks = g.tasks.filter(function (t) { return t && t.title; }).map(function (t) {
      var copy = JSON.parse(JSON.stringify(t));
      copy.id = uid();                       // 游客 id 可能和账号里的撞，全部换新
      if (!Array.isArray(copy.history)) copy.history = [];
      return copy;
    });
    if (!guestTasks.length) { try { localStorage.removeItem(GUEST_KEY); } catch (e) {} return; }
    var n = guestTasks.length;
    var hadTasks = state.tasks.length > 0;
    if (hadTasks) {
      var ok = confirm('这台设备上还有 ' + n + ' 件游客时记的事。\n\n并进「' + username + '」账号吗？并进去之后换手机也能看到。');
      if (!ok) return;
    }
    state.tasks = state.tasks.concat(guestTasks);
    state.lastOpenDate = todayStr();
    try { localStorage.removeItem(GUEST_KEY); } catch (e) {}
    rebuildReminders();
    render();
    persist();
    setTimeout(function () {
      alert(hadTasks
        ? '已并进账号：' + n + ' 件，现在一共 ' + state.tasks.length + ' 件。'
        : '这台设备上的 ' + n + ' 件事已经放进账号了，换手机登录也能看到。');
    }, 120);
  }

  function startGuest() {
    isGuest = true;
    try { localStorage.setItem(GUEST_FLAG, '1'); } catch (e) {}
    isAdmin = false;
    currentUsername = '';
    state = normalizeState(readGuestState());
    $('whoAmI').textContent = '';
    $('guestBadge').classList.remove('hidden');
    $('guestUpgrade').classList.remove('hidden');
    setSaveState('已存在本机');
    enterApp();
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
  var lastAddOpen = 0;
  function closeAdd() {
    var m = $('addMask');
    m.classList.remove('show');
    m.style.display = 'none';
    var f = $('fabAdd');
    if (f) f.classList.remove('hide');
  }
  function openAddWizard() {
    window.__addClicks = (window.__addClicks || 0) + 1;
    window.__step = '0-进入';
    try {
      var now = Date.now();
      if (now - lastAddOpen < 350) { window.__step = '1-被防抖拦下'; return; }
      lastAddOpen = now;
      draft = { title: '', deadline: '', impact: 2, urgency: 2 };
      window.__step = '2-draft';
      $('wzInput').value = '';
      $('wzError1').textContent = '';
      $('wzError2').textContent = '';
      $('wzError3').textContent = '';
      window.__step = '3-清空字段';
      showWizardPage(1);
      window.__step = '4-切到第一页';
      var mask = $('addMask');
      mask.classList.add('show');
      // 不跟 CSS 商量了，直接写死。所有关闭路径统一走 closeAdd
      mask.style.display = 'flex';
      mask.style.position = 'fixed';
      mask.style.left = '0'; mask.style.top = '0';
      mask.style.right = '0'; mask.style.bottom = '0';
      mask.style.zIndex = '9999';
      window.__step = '5-已设display=' + mask.style.display;
      var fab = $('fabAdd');
      if (fab) fab.classList.add('hide');
      mask.scrollTop = 0;
      var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (!coarse) setTimeout(function () { $('wzInput').focus(); }, 50);
      setTimeout(function () {
        var el = $('wzInput');
        if (!el) return;
        var r = el.getBoundingClientRect();
        var vh = window.innerHeight || document.documentElement.clientHeight || 0;
        if (r.top < 0 || r.bottom > vh) el.scrollIntoView({ block: 'center' });
      }, 300);
      window.__step = '6-完成';
    } catch (err) {
      window.__step = '错误: ' + (err && err.message ? err.message : String(err));
    }
  }
  (function bindAddBtn() {
    var btn = $('addBtn');
    if (!btn) return;
    btn.addEventListener('click', openAddWizard);
    btn.addEventListener('touchend', function (e) {
      e.preventDefault();
      openAddWizard();
    }, { passive: false });
  })();
  document.querySelectorAll('.chip[data-sample]').forEach(function (btn) {
    btn.onclick = function () { $('wzInput').value = btn.getAttribute('data-sample'); $('wzInput').focus(); };
  });
  $('wzCancel1').onclick = function () { closeAdd(); };
  $('wzNext1').onclick = function () {
    var raw = $('wzInput').value.trim();
    if (!raw) { $('wzError1').textContent = '随便说一句就行，比如「明天交房租」。'; return; }
    var parsed = window.Capture.parse(raw);
    if (!parsed.title || !parsed.title.trim()) {
      var heard = parsed.deadline ? window.Capture.friendlyDate(parsed.deadline, parsed.time) : '';
      $('wzError1').textContent = heard
        ? '时间我听懂了：' + heard + '。还差一句——做什么？'
        : '再多说几个字，我没听明白要做什么。比如「明天交房租」。';
      return;
    }
    draft.title = parsed.title;
    draft.deadline = parsed.deadline || shiftDay(todayStr(), 3);
    draft.time = parsed.time || '';
    $('wzTitle').value = draft.title;
    $('wzDatePreview').textContent = window.Capture.friendlyDate(draft.deadline, draft.time);
    $('wzDate').value = draft.deadline;
    if (parsed.shifted) {
      $('wzError2').textContent = '这个点今天过了，我挪到明天 ' + (parsed.time || '') + '。不对就自己改。';
      $('wzError2').style.color = '#92400e';
    } else if (!parsed.matched) {
      $('wzError2').textContent = '没听出时间，我先放了三天后，你可以改。';
    } else {
      $('wzError2').textContent = '';
    }
    showWizardPage(2);
  };
  $('wzBack2').onclick = function () { showWizardPage(1); };
  $('wzNext2').onclick = function () {
    var name = $('wzTitle').value.trim();
    if (!name) { $('wzError2').textContent = '写清楚要做什么，一个字也行。'; return; }
    if (!$('wzDate').value) { $('wzError2').textContent = '定个日期吧，这样明天才能提醒你。'; return; }
    if (diffDays(todayStr(), $('wzDate').value) < 0) { $('wzError2').textContent = '日期不能早于今天。'; return; }
    draft.title = name;
    draft.deadline = $('wzDate').value;
    showWizardPage(3);
    updateWizardResult();
  };
  $('wzBack3').onclick = function () { showWizardPage(2); };
  ['qImpact', 'qUrgency', 'qEffort'].forEach(function (id) {
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
    var effort = $('qEffort').querySelector('.sel').getAttribute('data-v');
    var q = window.Capture.quadrant(impact, urgency, true);
    draft.impact = +impact; draft.urgency = +urgency; draft.effort = +effort; draft.quadrant = q;
    var effortHint = +effort <= 2 ? '，会进「顺手清掉」' : '';
    $('wzResult').innerHTML = '<div class="wr-label">我打算把它放在</div><div class="wr-main">' + QUADS[q].name +
      '</div><div class="wr-why">' + QUADS[q].sub + '（重要 ' + impact + '/5 · 紧急 ' + urgency + '/5 · 费劲 ' + effort + '/5' + effortHint + '）</div>';
  }
  $('wzSave').onclick = function () {
    if (!draft.title || !draft.deadline) { $('wzError3').textContent = '前面的信息没了，请从头再来一次。'; return; }
    // 同名未完成的任务：问一句，不硬拦
    var dup = activeTasks().filter(function (t) {
      return t.title.replace(/\s/g, '') === draft.title.replace(/\s/g, '');
    })[0];
    if (dup) {
      var goOn = window.confirm('「' + dup.title + '」已经有一条，' + dup.deadline + '，还没做完。\n\n真要再来一条？\n确定 = 确实有两件事\n取消 = 不重复记，回清单看那条');
      if (!goOn) {
        closeAdd();
        refresh();
        return;
      }
    }
    state.tasks.push({
      id: uid(), title: draft.title, note: '',
      quadrant: draft.quadrant || 2, deadline: draft.deadline, time: draft.time || '',
      createdDate: todayStr(), status: 'pending', statusDate: null,
      carryCount: 0, lastCarryDate: null, history: [], doneDate: null,
      why: { impact: draft.impact, urgency: draft.urgency, effort: draft.effort }
    });
    closeAdd();
    refresh();
  };
  $('addMask').addEventListener('click', function (e) {
    if (e.target === $('addMask')) closeAdd();
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
      if (diffDays(t.deadline, todayStr()) > 0) t.quadrant = 9;
      refresh();
    }
    if (act === 'time') {
      // 允许 14:00 / 9:30 / 930 / 1430 几种写法；留空就是清掉，只按天提醒
      var rawT = String(e.target.value || '').trim().replace(/[：.]/g, ':');
      if (!rawT) {
        t.time = '';
        refresh();
        return;
      }
      var mm2 = rawT.match(/^(\d{1,2}):(\d{1,2})$/);
      if (!mm2) mm2 = rawT.match(/^(\d{1,2})(\d{2})$/);
      if (mm2) {
        var h2 = +mm2[1], n2 = +mm2[2];
        if (h2 <= 23 && n2 <= 59) {
          t.time = ('0' + h2).slice(-2) + ':' + ('0' + n2).slice(-2);
        } else {
          alert('时间不对，写成 14:00 这样。');
        }
      } else {
        alert('时间不对，写成 14:00 这样。留空就是只按日期提醒。');
      }
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
      if (diffDays(d.deadline, todayStr()) > 0) t.quadrant = 9;
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

  // 首次来的人需要看到步骤；老用户收起过一次就记住
  try {
    if (localStorage.getItem('dq_guide_collapsed') === '1') $('guide').classList.add('collapsed');
  } catch (e) {}
  $('guideHead').onclick = function () {
    var collapsed = $('guide').classList.toggle('collapsed');
    try { localStorage.setItem('dq_guide_collapsed', collapsed ? '1' : '0'); } catch (e) {}
  };

  $('reminderOpenBtn').onclick = function () {
    $('reminderMask').classList.add('show');
  };
  $('reminderClose').onclick = function () { $('reminderMask').classList.remove('show'); };
  $('reminderMask').addEventListener('click', function (e) {
    if (e.target === $('reminderMask')) $('reminderMask').classList.remove('show');
  });

  $('quickHead').onclick = function () {
    var box = $('quickList');
    var hidden = box.classList.toggle('hidden');
    $('quickChevron').classList.toggle('up', hidden);
  };

  $('moreBtn').onclick = function () {
    var open = $('headerActions').classList.toggle('menu-open');
    $('moreBtn').textContent = open ? '收起 ▴' : '更多（提醒·账号·导出）▾';
  };

  // 添加到主屏幕引导：只在浏览器里、未安装时显示
  (function initInstallBanner() {
    var standalone = window.navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
    if (standalone) return;
    var dismissed = false;
    try { dismissed = localStorage.getItem('dq_install_dismissed') === '1'; } catch (e) {}
    if (dismissed) return;
    var ua = navigator.userAgent;
    var isIOS = /iPad|iPhone|iPod/.test(ua);
    $('installHint').textContent = isIOS
      ? '点底部分享按钮 → 添加到主屏幕，推送才稳定'
      : '点浏览器菜单 → 添加到主屏幕，打开更快';
    $('installBanner').classList.remove('hidden');
    $('installDismiss').onclick = function () {
      $('installBanner').classList.add('hidden');
      try { localStorage.setItem('dq_install_dismissed', '1'); } catch (e) {}
    };
  })();

  $('refreshBtn').onclick = refresh;
  $('pushEnableBtn').onclick = togglePush;
  $('pushTestBtn').onclick = testPush;
  $('wxSave').onclick = saveWechat;
  $('wxTest').onclick = testWechat;

  $('accountBtn').onclick = function () {
    $('acctName').textContent = currentUsername || '—';
    $('acctEmail').textContent = '读取中…';
    $('acctRole').textContent = isAdmin ? '管理员' : '普通用户';
    $('accountMask').classList.add('show');
    api('GET', '/api/me').then(function (r) {
      $('acctEmail').textContent = r.email || '未绑定';
    }).catch(function (e) { $('acctEmail').textContent = e.message; });
  };
  $('acctClose').onclick = function () { $('accountMask').classList.remove('show'); };
  $('acctCopy').onclick = function () {
    try {
      navigator.clipboard.writeText(currentUsername);
      $('acctCopy').textContent = '已复制';
      setTimeout(function () { $('acctCopy').textContent = '复制账号名'; }, 1500);
    } catch (e) { $('acctCopy').textContent = '复制失败，请手动记'; }
  };
  $('accountMask').addEventListener('click', function (e) {
    if (e.target === $('accountMask')) $('accountMask').classList.remove('show');
  });

  function loadReminderMode() {
    api('GET', '/api/reminder/mode').then(function (r) {
      var mode = r.mode || 'normal';
      document.querySelectorAll('.mode-btn').forEach(function (b) {
        b.classList.toggle('sel', b.getAttribute('data-mode') === mode);
      });
      $('modeState').textContent = '';
    }).catch(function () {});
  }
  document.querySelectorAll('.mode-btn').forEach(function (b) {
    b.onclick = function () {
      var mode = b.getAttribute('data-mode');
      api('POST', '/api/reminder/mode', { mode: mode }).then(function () {
        document.querySelectorAll('.mode-btn').forEach(function (x) {
          x.classList.toggle('sel', x === b);
        });
        $('modeState').textContent = '已保存';
      }).catch(function (e) { $('modeState').textContent = e.message; });
    };
  });

  function setAdminCollapsed(collapsed) {
    $('adminBody').classList.toggle('collapsed', collapsed);
    $('adminChevron').classList.toggle('up', collapsed);
    $('adminHint').textContent = collapsed ? '已配置 · 点开修改' : '仅管理员可见';
  }
  $('adminHead').onclick = function () {
    setAdminCollapsed(!$('adminBody').classList.contains('collapsed'));
  };

  function loadSmtpState() {
    api('GET', '/api/admin/smtp').then(function (r) {
      $('smtpHost').value = r.host || '';
      $('smtpPort').value = r.port || '465';
      $('smtpUser').value = r.user || '';
      $('smtpSender').value = r.sender || '';
      $('smtpState').textContent = r.configured ? '已开启邮箱验证' : '邮箱验证未开启';
      setAdminCollapsed(!!r.configured);
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
      setAdminCollapsed(true);
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

  $('reviewMask').addEventListener('click', function (e) { if (e.target === $('reviewMask')) $('reviewMask').classList.remove('show'); });

  // 备用入口：地址后面加 #add 直接打开新增框。按钮点不动时用它验证是不是点击的问题
  if (location.hash === '#add') setTimeout(function () { openAddWizard(); }, 200);
  // 右下角悬浮按钮走内联 onclick，不依赖事件绑定是否成功
  window.__openAdd = openAddWizard;

  // 诊断模式：地址加 ?diag=1，页面底部实时显示脚本状态和点击次数
  if (/[?&]diag=1/.test(location.search)) {
    var dbar = document.createElement('div');
    dbar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99998;background:#111827;' +
      'color:#4ade80;font:12px/1.5 ui-monospace,monospace;padding:6px 10px;white-space:pre-wrap';
    document.body.appendChild(dbar);
    var updDiag = function () {
      dbar.textContent = '点击=' + (window.__addClicks || 0) +
        ' | 步骤=' + (window.__step || '-') +
        ' | 弹窗=' + getComputedStyle($('addMask')).display +
        ' | fab=' + getComputedStyle($('fabAdd')).display + ' | v33';
    };
    updDiag();
    setInterval(updDiag, 500);
  }

  // 把新增弹窗挂到 body 末尾：避免被祖先元素的 overflow / transform 影响 fixed 定位
  try { document.body.appendChild($('addMask')); } catch (e) {}

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
