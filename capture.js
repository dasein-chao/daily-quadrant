(function (global) {
  'use strict';

  // 从一句中文里抽出日期和任务描述。纯规则，不依赖网络。
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function toStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function weekdayToNum(ch) {
    var map = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
    return map[ch];
  }

  function parse(raw) {
    var text = String(raw || '').trim();
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var found = null;
    var span = null;
    var lower = text;

    function setDate(d) { found = new Date(d.getTime()); }

    // 相对日
    var rel = [
      { re: /大后天/, n: 3 }, { re: /后天/, n: 2 }, { re: /明天|明日/, n: 1 }, { re: /今天|今日/, n: 0 }
    ];
    for (var i = 0; i < rel.length; i++) {
      if (rel[i].re.test(lower)) { span = rel[i].re; var d = new Date(today); d.setDate(d.getDate() + rel[i].n); setDate(d); break; }
    }

    // N 天后 / N 天内
    if (!found) {
      var m = lower.match(/(\d+|[一二三四五六七八九十]+)\s*天[后内之]?/);
      if (m) {
        var n = cnNum(m[1]);
        if (n !== null && n >= 0 && n <= 365) {
          span = new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
          var dd = new Date(today); dd.setDate(dd.getDate() + n); setDate(dd);
        }
      }
    }

    // 下周X / 这周X / 周X / 星期X
    if (!found) {
      var wk = lower.match(/(下下|下|这个|这|本|上个|上)?\s*(周|星期)\s*([日天一二三四五六])/);
      if (wk) {
        var target = weekdayToNum(wk[3]);
        var base = new Date(today);
        var cur = base.getDay();
        var mondayOffset = (cur + 6) % 7;
        var thisMonday = new Date(today); thisMonday.setDate(thisMonday.getDate() - mondayOffset);
        var prefix = wk[1] || '';
        var targetFromMonday = (target + 6) % 7;
        var delta;
        if (prefix === '下') {
          delta = 7 + targetFromMonday;
        } else if (prefix === '下下') {
          delta = 14 + targetFromMonday;
        } else if (prefix === '上' || prefix === '上个') {
          delta = -7 + targetFromMonday;
        } else {
          delta = targetFromMonday;
          if (delta <= mondayOffset) delta += 7;
        }
        base.setTime(thisMonday.getTime());
        base.setDate(base.getDate() + delta);
        span = new RegExp(wk[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        setDate(base);
      }
    }

    // X月X日 / X月X号 / X/X
    if (!found) {
      var md = lower.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
      if (md) {
        var mo = +md[1] - 1, day = +md[2];
        var y = today.getFullYear();
        var cand = new Date(y, mo, day);
        if (cand < today) cand = new Date(y + 1, mo, day);
        span = new RegExp(md[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        setDate(cand);
      }
    }
    if (!found) {
      var slash = lower.match(/(\d{1,2})\/(\d{1,2})/);
      if (slash) {
        var m2 = +slash[1] - 1, d2 = +slash[2];
        var y2 = today.getFullYear();
        var c2 = new Date(y2, m2, d2);
        if (c2 < today) c2 = new Date(y2 + 1, m2, d2);
        span = new RegExp(slash[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        setDate(c2);
      }
    }

    // 本周内 / 这周 / 月底 / 下周
    if (!found && /本周内|这周内|这周|本周/.test(lower)) {
      span = /本周内|这周内|这周|本周/;
      var e = new Date(today); e.setDate(e.getDate() + 7); setDate(e);
    }
    if (!found && /月底|月末/.test(lower)) {
      span = /月底|月末/;
      var last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      setDate(last);
    }
    if (!found && /下周/.test(lower)) {
      span = /下周/;
      var nx = new Date(today); nx.setDate(nx.getDate() + 7); setDate(nx);
    }

    var title = text;
    if (span) title = title.replace(span, ' ');
    title = title.replace(/^\s*(下下|下|这个|这|本|上个|上)\s*$/, ' ');
    title = title.replace(/^(这个|下下|下|本|上个|上|这)+(?=[^\s])/, '');
    title = title.replace(/这个|这个之前|之前要|之前完成|之前交|之前|截止|deadline|前/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    title = title.replace(/^[，,。、：:\s]+|[，,。、：:\s]+$/g, '');

    if (!title) title = text;
    return { title: title, deadline: found ? toStr(found) : null, matched: !!found };
  }

  function cnNum(s) {
    if (/^\d+$/.test(s)) return +s;
    var map = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    if (s === '十') return 10;
    if (s.indexOf('十') === 0) return 10 + (map[s.charAt(1)] || 0);
    if (s.length === 2 && s.charAt(1) === '十') return (map[s.charAt(0)] || 0) * 10;
    return map[s] === undefined ? null : map[s];
  }

  function friendlyDate(dateStr) {
    if (!dateStr) return '还没定时间';
    var d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var diff = Math.round((d.getTime() - today.getTime()) / 86400000);
    var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    var label = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' :
      (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + wd;
    if (diff > 2 && diff < 30) label += '（还有 ' + diff + ' 天）';
    return label;
  }

  // 两个问题映射成象限：1=马上做 2=安排做 3=能推就推 4=可以不做
  function quadrant(impact, urgency, hasDeadline) {
    var a = +impact || 2, u = +urgency || 2;
    if (a >= 3 && u >= 3) return 1;
    if (a >= 3) return 2;
    if (u >= 3) return 3;
    if (a === 1 && u === 1) return 4;
    if (!hasDeadline && a === 2 && u === 2) return 2;
    return 3;
  }

  global.Capture = { parse: parse, friendlyDate: friendlyDate, quadrant: quadrant };
})(typeof window !== 'undefined' ? window : globalThis);
