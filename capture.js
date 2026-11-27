(function (global) {
  'use strict';

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function toStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function weekdayToNum(ch) {
    var map = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
    return map[ch];
  }

  // 中文数字转数字，支持 一~九十九 / 半
  function cnNum(s) {
    if (/^\d+$/.test(s)) return +s;
    if (s === '半') return 0.5;
    var map = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (s === '十') return 10;
    var idx = s.indexOf('十');
    if (idx === 0) return 10 + (map[s.charAt(1)] || 0);
    if (idx > 0) {
      var tens = map[s.charAt(0)] || 0;
      var ones = s.charAt(idx + 1) ? (map[s.charAt(idx + 1)] || 0) : 0;
      return tens * 10 + ones;
    }
    return map[s] === undefined ? null : map[s];
  }

  // 从一句中文里抽日期、时段、钟点、任务名。纯规则，不依赖网络。
  // 关键：时间点和日期分开解析；标题按"命中位置"删除，不用正则链反复替换（那样会互踩吃字）。
  function parse(raw) {
    var text = String(raw || '').trim();
    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var date = null;
    var period = null;
    var hour = null;
    var minute = null;
    var cuts = [];
    var lower = text;

    function mark(m) {
      if (!m) return;
      cuts.push({ start: m.index, end: m.index + m[0].length });
    }
    // 合并重叠区间，避免倒序删除时索引错位
    function mergeCuts() {
      if (!cuts.length) return [];
      var sorted = cuts.slice().sort(function (a, b) { return a.start - b.start; });
      var out = [sorted[0]];
      for (var j = 1; j < sorted.length; j++) {
        var last = out[out.length - 1];
        if (sorted[j].start <= last.end) {
          last.end = Math.max(last.end, sorted[j].end);
        } else {
          out.push(sorted[j]);
        }
      }
      return out;
    }

    // ---------- 1. 日期 ----------
    var relList = [
      { re: /大后天/, n: 3 },
      { re: /后天/, n: 2 },
      { re: /明天|明日|明早|明晚|明儿/, n: 1 },
      { re: /今天|今日|今早|今晚|今儿/, n: 0 }
    ];
    var relHit = false;
    for (var i = 0; i < relList.length; i++) {
      var m = lower.match(relList[i].re);
      if (m) {
        var d = new Date(today);
        d.setDate(d.getDate() + relList[i].n);
        date = d;
        relHit = true;
        mark(m);
        break;
      }
    }

    if (!date) {
      var mDays = lower.match(/(\d+|[一二两三四五六七八九十]+)\s*天\s*[后内以之]?/);
      if (mDays) {
        var n = cnNum(mDays[1]);
        if (n !== null && n >= 0 && n <= 365) {
          var dd = new Date(today);
          dd.setDate(dd.getDate() + n);
          date = dd;
          mark(mDays);
        }
      }
    }

    // 周末 / 这周末 / 下周末
    if (!date) {
      var mWeekend = lower.match(/(这|本|下)?\s*(周末|双休)/);
      if (mWeekend) {
        var off0 = (today.getDay() + 6) % 7;
        var mon0 = new Date(today); mon0.setDate(mon0.getDate() - off0);
        var sat = new Date(mon0); sat.setDate(sat.getDate() + 5);
        if (sat < today) sat.setDate(sat.getDate() + 7);
        if (mWeekend[1] === '下') sat.setDate(sat.getDate() + 7);
        date = sat;
        mark(mWeekend);
      }
    }

    if (!date) {
      var mWk = lower.match(/(下下|下|这个|这|本|上个|上)?\s*(周|星期)\s*([日天一二三四五六])/);
      if (mWk) {
        var target = weekdayToNum(mWk[3]);
        var cur = today.getDay();
        var monOff = (cur + 6) % 7;
        var thisMon = new Date(today); thisMon.setDate(thisMon.getDate() - monOff);
        var prefix = mWk[1] || '';
        var targetFromMon = (target + 6) % 7;
        var delta;
        if (prefix === '下') delta = 7 + targetFromMon;
        else if (prefix === '下下') delta = 14 + targetFromMon;
        else if (prefix === '上' || prefix === '上个') delta = -7 + targetFromMon;
        else {
          delta = targetFromMon;
          if (delta <= monOff) delta += 7;
        }
        var wd = new Date(thisMon); wd.setDate(wd.getDate() + delta);
        date = wd;
        mark(mWk);
      }
    }

    if (!date) {
      var mMd = lower.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
      if (mMd) {
        var cand = new Date(today.getFullYear(), +mMd[1] - 1, +mMd[2]);
        if (cand < today) cand = new Date(today.getFullYear() + 1, +mMd[1] - 1, +mMd[2]);
        date = cand;
        mark(mMd);
      }
    }
    if (!date) {
      var mSlash = lower.match(/(\d{1,2})\/(\d{1,2})/);
      if (mSlash) {
        var c2 = new Date(today.getFullYear(), +mSlash[1] - 1, +mSlash[2]);
        if (c2 < today) c2 = new Date(today.getFullYear() + 1, +mSlash[1] - 1, +mSlash[2]);
        date = c2;
        mark(mSlash);
      }
    }
    if (!date) {
      var mThisWeek = lower.match(/本周内|这周内|这周|本周/);
      if (mThisWeek) {
        var off2 = (today.getDay() + 6) % 7;
        var mon2 = new Date(today); mon2.setDate(mon2.getDate() - off2);
        var e = new Date(mon2); e.setDate(e.getDate() + 6);
        if (e < today) e.setDate(e.getDate() + 7);
        date = e;
        mark(mThisWeek);
      }
    }
    if (!date) {
      var mMonthEnd = lower.match(/月底|月末/);
      if (mMonthEnd) {
        date = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        mark(mMonthEnd);
      }
    }
    if (!date && !relHit) {
      var mNextWeek = lower.match(/下周/);
      if (mNextWeek) {
        var nx = new Date(today); nx.setDate(nx.getDate() + 7);
        date = nx;
        mark(mNextWeek);
      }
    }

    // ---------- 2. 时段 ----------
    var mPeriod = lower.match(/(凌晨|清晨|早[上晨]|上午|中午|下午|傍晚|晚上|夜间|夜里)/);
    if (mPeriod) {
      period = mPeriod[1];
      mark(mPeriod);
    }
    // 「今晚」「明早」这类词已在日期步骤被吃掉，需要从中补回时段
    if (!period) {
      if (/今晚|夜里|夜间/.test(lower)) period = '晚上';
      else if (/今早|明早|明儿早/.test(lower)) period = '早上';
      else if (/明晚/.test(lower)) period = '晚上';
    }

    // ---------- 3. 钟点 ----------
    var mClock = lower.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
    if (mClock) {
      hour = +mClock[1];
      minute = +mClock[2];
      mark(mClock);
    } else {
      var mHour = lower.match(/(\d{1,2}|[一二两三四五六七八九十]+)\s*[点时](\s*(半|一刻|三刻|\d{1,2}|[一二三四五六七八九十]+)\s*分?)?/);
      if (mHour) {
        var h = cnNum(mHour[1]);
        if (h !== null) {
          hour = h;
          var tail = mHour[2] ? mHour[2].trim() : '';
          if (tail === '半') minute = 30;
          else if (tail === '一刻') minute = 15;
          else if (tail === '三刻') minute = 45;
          else if (tail) {
            var mm = cnNum(tail.replace(/分$/, '').trim());
            minute = mm === null ? 0 : mm;
          } else minute = 0;
          mark(mHour);
        }
      }
    }

    // ---------- 4. X 分钟后 / 小时后 ----------
    if (hour === null) {
      var mAfter = lower.match(/(半|(\d+|[一二两三四五六七八九十]+))\s*(个)?\s*(小时|钟头|分钟)\s*(后|以后|之后)/);
      if (mAfter) {
        var num = mAfter[1] === '半' ? 0.5 : cnNum(mAfter[1]);
        if (num !== null) {
          var nowT0 = new Date();
          var addMin = mAfter[4] === '分钟' ? num : num * 60;
          var t0 = new Date(nowT0.getTime() + addMin * 60000);
          date = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate());
          hour = t0.getHours();
          minute = t0.getMinutes();
          mark(mAfter);
        }
      }
    }

    // ---------- 5. 时段换算 24 小时 ----------
    if (hour !== null && period) {
      if (/下午|傍晚|晚上|夜间|夜里/.test(period) && hour < 12) hour += 12;
      else if (/中午/.test(period) && hour < 11) hour += 12;
      else if ((/凌晨|^早[上晨]$/.test(period)) && hour === 12) hour = 0;
      if (hour > 23) hour = 23;
    } else if (hour !== null && hour >= 1 && hour <= 6) {
      // 口语没说时段时，「一点到六点」按白天算——人白天说话不会指凌晨
      hour += 12;
    }

    // ---------- 6. 有钟点没日期：默认今天；已过则顺延明天 ----------
    var shifted = false;   // 是否因时间已过而顺延
    if (hour !== null && !date) {
      var nowT = new Date();
      var cand2 = new Date(today);
      cand2.setHours(hour, minute || 0, 0, 0);
      if (cand2.getTime() < nowT.getTime()) {
        cand2.setDate(cand2.getDate() + 1);
        shifted = true;
      }
      date = new Date(cand2.getFullYear(), cand2.getMonth(), cand2.getDate());
    }
    // 只说了时段没说钟点：默认今天
    if (!date && period) date = new Date(today);

    // 说了"今天/今早"但那个点已经过了：顺延到明天，避免定了条永远不响的提醒
    if (date && hour !== null && !shifted) {
      var guess = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute || 0, 0, 0);
      if (guess.getTime() < new Date().getTime()) {
        date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
        shifted = true;
      }
    }

    // ---------- 7. 按命中位置删片段 ----------
    var merged = mergeCuts();
    merged.sort(function (a, b) { return b.start - a.start; });
    var title = text;
    for (var c = 0; c < merged.length; c++) {
      title = title.slice(0, merged[c].start) + ' ' + title.slice(merged[c].end);
    }

    title = title.replace(/之前要|之前完成|之前交|之前|截止|deadline|以前/gi, ' ');
    // 删掉"八点"后常留下一个"前"贴在下个词前面，直接去掉这个残留
    title = title.replace(/^\s*[前内]\s*(?=\S)/, '');
    title = title.replace(/\s+[前内](?=\S)/g, ' ');
    title = title.replace(/^\s*[前内]\s*$/, '');
    title = title.replace(/\s+/g, ' ').trim();
    // 删掉时间后常留下孤立的「的」「了」「在」，一并清掉
    title = title.replace(/^[的了在]\s*/, '').replace(/\s+[的了]$/, '').trim();
    title = title.replace(/^[，,。、：:\s]+|[，,。、：:\s]+$/g, '');
    title = title.replace(/^要(?=\S)/, '').trim();

    // 整句都是时间时，不要把时间当任务名，留空让用户补
    if (!title) title = '';

    return {
      title: title,
      deadline: date ? toStr(date) : null,
      period: period,
      time: hour !== null ? pad(hour) + ':' + pad(minute || 0) : null,
      shifted: shifted,
      matched: !!date || !!period || hour !== null
    };
  }

  function friendlyDate(dateStr, timeStr) {
    if (!dateStr) return timeStr ? ('今天 ' + timeStr) : '还没定时间';
    var d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var diff = Math.round((d.getTime() - today.getTime()) / 86400000);
    var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    var label = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' :
      (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + wd;
    if (diff > 2 && diff < 30) label += '（还有 ' + diff + ' 天）';
    if (timeStr) label += ' ' + timeStr;
    return label;
  }

  // 两问各 5 档（25 种组合）→ 3×3 共 9 格。编号越大越该优先做。
  function quadrant(impact, urgency, hasDeadline) {
    var a = Math.max(1, Math.min(5, +impact || 3));
    var u = Math.max(1, Math.min(5, +urgency || 3));
    var li = a >= 4 ? 2 : (a >= 3 ? 1 : 0);
    var lu = u >= 4 ? 2 : (u >= 3 ? 1 : 0);
    return li * 3 + lu + 1;
  }

  global.Capture = { parse: parse, friendlyDate: friendlyDate, quadrant: quadrant };
})(typeof window !== 'undefined' ? window : globalThis);
