import os
import json
import time
import hmac
import base64
import hashlib
import secrets
import sqlite3
import datetime
import threading
import subprocess
import http.server
import socketserver
import urllib.parse
import urllib.request
import smtplib
import shutil
import re
from email.mime.text import MIMEText
from email.utils import formataddr
from contextlib import closing

ROOT = os.path.dirname(os.path.abspath(__file__))
# 数据必须放在代码目录之外：每次部署会重写代码目录，放里面等于每次清库
DATA_DIR = os.environ.get('DQ_DATA_DIR') or os.path.join(
    os.path.expanduser('~'), '.daily-quadrant')
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, 'data.db')
VAPID_PRIVATE_PATH = os.path.join(DATA_DIR, 'vapid_private.pem')
PORT = int(os.environ.get('PORT', '3000'))
COOKIE = 'dq_session'
PBKDF2_ROUNDS = 200000
MAX_BODY = 1024 * 1024
VAPID_SUBJECT = 'mailto:daily-quadrant@example.com'
PUSHPLUS_API = os.environ.get('PUSHPLUS_API', 'https://www.pushplus.plus/send')
PUSHPLUS_CHANNELS = ('wechat', 'clawbot', 'app', 'extension', 'mail', 'webhook')

STATIC = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/index.html': ('index.html', 'text/html; charset=utf-8'),
    '/app.js': ('app.js', 'application/javascript; charset=utf-8'),
    '/capture.js': ('capture.js', 'application/javascript; charset=utf-8'),
    '/styles.css': ('styles.css', 'text/css; charset=utf-8'),
    '/sw.js': ('sw.js', 'application/javascript; charset=utf-8'),
    '/manifest.webmanifest': ('manifest.webmanifest', 'application/manifest+json; charset=utf-8'),
    '/icon.svg': ('icon.svg', 'image/svg+xml'),
}


def count_users(path):
    try:
        c = sqlite3.connect(path)
        n = c.execute('SELECT COUNT(*) FROM users').fetchone()[0]
        c.close()
        return n
    except Exception:
        return -1


def migrate_legacy_db():
    """老版本把 data.db 放在代码目录里，部署会清掉。
    启动时找旧库：只要旧库里的人比现用库多，就认定旧库才是真的，换回来。
    换之前先把手上的库另存一份，不覆盖着丢。"""
    legacy = os.path.join(ROOT, 'data.db')
    if not os.path.exists(legacy):
        return
    old_n = count_users(legacy)
    cur_n = count_users(DB_PATH) if os.path.exists(DB_PATH) else -1
    if old_n > cur_n:
        try:
            if os.path.exists(DB_PATH):
                shutil.copy2(DB_PATH, DB_PATH + '.before-recover')
            shutil.copy2(legacy, DB_PATH)
            print('recovered legacy db: %d users -> %d users' % (cur_n, old_n), flush=True)
        except Exception:
            pass


def backup_db(keep_hours=168):
    """每小时留一份副本，保留 7 天（168 份）。

    为什么是小时级：任务清单能接受最坏丢一小时。再密就是在拿磁盘和 IO 换
    一件几乎不会发生的事；再稀，丢的可能就是今天下午刚记的东西。
    """
    if not os.path.exists(DB_PATH):
        return
    try:
        stamp = datetime.datetime.now().strftime('%Y-%m-%dT%H')
        dest = os.path.join(DATA_DIR, 'backup-' + stamp + '.db')
        if not os.path.exists(dest):
            # 用 SQLite 的在线备份接口，不要直接复制文件。
            # 有人正在写的时候 copy2 会复制出一个半截的库，打开就报错——
            # 这种备份平时看不出来，真出事才发现是废的。
            src = sqlite3.connect(DB_PATH, timeout=10)
            try:
                dst = sqlite3.connect(dest)
                try:
                    with dst:
                        src.backup(dst)
                finally:
                    dst.close()
            finally:
                src.close()
        olds = sorted(
            f for f in os.listdir(DATA_DIR)
            if f.startswith('backup-') and f.endswith('.db')
        )
        for f in olds[:-keep_hours]:
            os.remove(os.path.join(DATA_DIR, f))
    except Exception:
        pass


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    # 忙等而不是立刻报错：多用户同时写时排队，别让用户看到「数据库被锁」
    conn.execute('PRAGMA busy_timeout=10000')
    return conn


def init_db():
    with closing(connect()) as conn:
        # WAL：读不阻塞写，写不阻塞读。多人同时打开时不会互相卡住。
        # 这是文件级持久设置，设一次就一直生效。
        try:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA synchronous=NORMAL')
        except sqlite3.Error:
            pass
        with conn:
            conn.execute('''CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                salt TEXT NOT NULL,
                pass_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )''')
            conn.execute('''CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )''')
            conn.execute('''CREATE TABLE IF NOT EXISTS states (
                user_id INTEGER PRIMARY KEY,
                data TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id)
            )''')
            conn.execute('''CREATE TABLE IF NOT EXISTS push_subscriptions (
                user_id INTEGER NOT NULL,
                endpoint TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, endpoint)
            )''')
            conn.execute('''CREATE TABLE IF NOT EXISTS push_log (
                user_id INTEGER NOT NULL,
                task_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                sent_date TEXT NOT NULL,
                PRIMARY KEY (user_id, task_id, kind, sent_date)
            )''')
            conn.execute('''CREATE TABLE IF NOT EXISTS push_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                url TEXT NOT NULL DEFAULT '/',
                created_at INTEGER NOT NULL
            )''')
            conn.execute('''CREATE TABLE IF NOT EXISTS settings (
                user_id INTEGER PRIMARY KEY,
                pushplus_token TEXT NOT NULL DEFAULT '',
                pushplus_channel TEXT NOT NULL DEFAULT 'wechat',
                email_notify INTEGER NOT NULL DEFAULT 1,
                reminder_mode TEXT NOT NULL DEFAULT 'normal',
                FOREIGN KEY(user_id) REFERENCES users(id)
            )''')
            s_cols = {r['name'] for r in conn.execute('PRAGMA table_info(settings)').fetchall()}
            if 'email_notify' not in s_cols:
                conn.execute('ALTER TABLE settings ADD COLUMN email_notify INTEGER NOT NULL DEFAULT 1')
            if 'reminder_mode' not in s_cols:
                conn.execute("ALTER TABLE settings ADD COLUMN reminder_mode TEXT NOT NULL DEFAULT 'normal'")
            # 邮箱验证与管理员：对已有库做增量迁移，不丢旧数据
            cols = {r['name'] for r in conn.execute('PRAGMA table_info(users)').fetchall()}
            if 'email' not in cols:
                conn.execute('ALTER TABLE users ADD COLUMN email TEXT')
            if 'is_admin' not in cols:
                conn.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
            conn.execute('''CREATE TABLE IF NOT EXISTS server_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )''')
            conn.execute('''CREATE TABLE IF NOT EXISTS email_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                purpose TEXT NOT NULL DEFAULT 'register',
                code_hash TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                used INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            )''')
            code_cols = {r['name'] for r in conn.execute('PRAGMA table_info(email_codes)').fetchall()}
            if 'purpose' not in code_cols:
                conn.execute("ALTER TABLE email_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'register'")
            conn.execute('CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email)')
            # 开发期测试账号不得占据管理员位（含发布后验证持久化用的探针账号）
            test_names = ('live_test', 'tester_a', 'tester_b', 'pushuser', 'wxuser',
                          'newui', 'checksuser', 'admin1', 'newuser', 'owner_check',
                          'probe1', 'probe2', 'snaptest')
            for name in test_names:
                conn.execute('UPDATE users SET is_admin = 0 WHERE username = ?', (name,))
            # 没有管理员时，把最早的真实账号提升，避免没人能配 SMTP
            admin = conn.execute('SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1').fetchone()
            if not admin:
                placeholders = ','.join('?' for _ in test_names)
                first = conn.execute(
                    "SELECT id FROM users WHERE email NOT LIKE ? "
                    "AND username NOT IN (" + placeholders + ") ORDER BY id LIMIT 1",
                    ['%@example.com'] + list(test_names)
                ).fetchone()
                if first:
                    conn.execute('UPDATE users SET is_admin = 1 WHERE id = ?', (first['id'],))


def get_server_setting(conn, key, default=''):
    row = conn.execute('SELECT value FROM server_settings WHERE key = ?', (key,)).fetchone()
    return row['value'] if row else default


def set_server_setting(conn, key, value):
    with conn:
        conn.execute(
            'INSERT INTO server_settings (key, value) VALUES (?, ?) '
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            (key, str(value))
        )


def smtp_config(conn):
    return {
        'host': get_server_setting(conn, 'smtp_host'),
        'port': get_server_setting(conn, 'smtp_port', '465'),
        'user': get_server_setting(conn, 'smtp_user'),
        'password': get_server_setting(conn, 'smtp_password'),
        'sender': get_server_setting(conn, 'smtp_sender'),
    }


def smtp_ready(cfg):
    return bool(cfg['host'] and cfg['user'] and cfg['password'])


def send_email(cfg, to_addr, subject, body):
    if not smtp_ready(cfg):
        raise ValueError('邮件服务尚未配置')
    try:
        port = int(cfg['port'])
    except (TypeError, ValueError):
        raise ValueError('端口必须是数字')
    msg = MIMEText(body, 'plain', 'utf-8')
    msg['Subject'] = subject
    # 发件地址必须是 ASCII 邮箱，中文只能放显示名
    sender = cfg['user']
    display = cfg['sender'] or '每日四象限'
    msg['From'] = formataddr((display, sender))
    msg['To'] = to_addr
    if port == 465:
        client = smtplib.SMTP_SSL(cfg['host'], port, timeout=15)
    else:
        client = smtplib.SMTP(cfg['host'], port, timeout=15)
        client.starttls()
    try:
        client.login(cfg['user'], cfg['password'])
        client.sendmail(sender, [to_addr], msg.as_string())
    finally:
        try:
            client.quit()
        except Exception:
            pass


def is_valid_email(value):
    return bool(re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', value or ''))


def create_email_code(conn, email, purpose='register'):
    code = '{:06d}'.format(secrets.randbelow(1000000))
    code_hash = hashlib.sha256((code + ':' + email + ':' + purpose).encode('utf-8')).hexdigest()
    now = int(time.time())
    with conn:
        conn.execute('UPDATE email_codes SET used = 1 WHERE email = ? AND used = 0', (email,))
        conn.execute(
            'INSERT INTO email_codes (email, purpose, code_hash, expires_at, used, created_at) '
            'VALUES (?, ?, ?, ?, 0, ?)',
            (email, purpose, code_hash, now + 600, now)
        )
    return code


def verify_email_code(conn, email, code, purpose='register'):
    code_hash = hashlib.sha256((code + ':' + email + ':' + purpose).encode('utf-8')).hexdigest()
    row = conn.execute(
        'SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND used = 0 ORDER BY id DESC LIMIT 1',
        (email, purpose)
    ).fetchone()
    if not row or row['expires_at'] < int(time.time()):
        return False
    if not hmac.compare_digest(row['code_hash'], code_hash):
        return False
    with conn:
        conn.execute('UPDATE email_codes SET used = 1 WHERE id = ?', (row['id'],))
    return True


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def der_integer(data, pos):
    if pos + 2 > len(data) or data[pos] != 0x02:
        raise ValueError('bad DER integer')
    length = data[pos + 1]
    value = data[pos + 2:pos + 2 + length]
    value = value.lstrip(b'\x00') or b'\x00'
    return int.from_bytes(value, 'big'), pos + 2 + length


def der_signature_to_raw(sig):
    if not sig or sig[0] != 0x30:
        raise ValueError('bad DER signature')
    r, pos = der_integer(sig, 2)
    s, _ = der_integer(sig, pos)
    return r.to_bytes(32, 'big') + s.to_bytes(32, 'big')


def load_or_create_vapid():
    try:
        if not os.path.exists(VAPID_PRIVATE_PATH):
            subprocess.run(
                ['openssl', 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', VAPID_PRIVATE_PATH],
                check=True, capture_output=True
            )
        der = subprocess.run(
            ['openssl', 'ec', '-in', VAPID_PRIVATE_PATH, '-pubout', '-outform', 'DER'],
            check=True, capture_output=True
        ).stdout
        point = der[-65:]
        if point[0] != 0x04 or len(point) != 65:
            raise ValueError('bad public key')
        return b64url(point)
    except Exception as exc:
        print('push disabled: ' + str(exc), flush=True)
        return None


VAPID_PUBLIC = load_or_create_vapid()


def vapid_jwt(endpoint):
    parsed = urllib.parse.urlparse(endpoint)
    audience = parsed.scheme + '://' + parsed.netloc
    header = b64url(json.dumps({'alg': 'ES256', 'typ': 'JWT'}, separators=(',', ':')).encode('utf-8'))
    claims = {'aud': audience, 'exp': int(time.time()) + 43200, 'sub': VAPID_SUBJECT}
    payload = b64url(json.dumps(claims, separators=(',', ':')).encode('utf-8'))
    signing_input = (header + '.' + payload).encode('ascii')
    der = subprocess.run(
        ['openssl', 'dgst', '-sha256', '-sign', VAPID_PRIVATE_PATH],
        input=signing_input, check=True, capture_output=True
    ).stdout
    return header + '.' + payload + '.' + b64url(der_signature_to_raw(der))


def queue_message(conn, user_id, title, body, url='/'):
    with conn:
        conn.execute(
            'INSERT INTO push_messages (user_id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?)',
            (user_id, title, body, url, int(time.time()))
        )


def get_pushplus_config(conn, user_id):
    row = conn.execute(
        'SELECT pushplus_token, pushplus_channel FROM settings WHERE user_id = ?', (user_id,)
    ).fetchone()
    if not row:
        return '', 'wechat'
    return row['pushplus_token'], row['pushplus_channel']


def send_pushplus(conn, user_id, title, body):
    token, channel = get_pushplus_config(conn, user_id)
    if not token:
        return False
    payload = {
        'token': token,
        'title': title,
        'content': body,
        'template': 'txt',
        'channel': channel or 'wechat'
    }
    try:
        request = urllib.request.Request(
            PUSHPLUS_API,
            data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
            method='POST',
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.loads(response.read().decode('utf-8'))
            return result.get('code') == 200
    except Exception:
        return False


def get_email_notify(conn, user_id):
    row = conn.execute('SELECT email_notify FROM settings WHERE user_id = ?', (user_id,)).fetchone()
    return bool(row['email_notify']) if row else True


def get_reminder_mode(conn, user_id):
    row = conn.execute('SELECT reminder_mode FROM settings WHERE user_id = ?', (user_id,)).fetchone()
    mode = row['reminder_mode'] if row else 'normal'
    return mode if mode in ('quiet', 'normal', 'force') else 'normal'


def send_deadline_email(conn, user_id, title, body):
    # 已下线：邮件打开率太低，提醒改走浏览器推送和微信。
    # SMTP 配置保留，只服务「找回密码」验证码。
    return False


def _send_deadline_email_retired(conn, user_id, title, body):
    cfg = smtp_config(conn)
    if not smtp_ready(cfg) or not get_email_notify(conn, user_id):
        return False
    row = conn.execute('SELECT email FROM users WHERE id = ?', (user_id,)).fetchone()
    if not row or not row['email']:
        return False
    try:
        send_email(cfg, row['email'], title,
                   body + '\n\n——来自「每日四象限」，可在网页里关闭邮件提醒。')
        return True
    except Exception:
        return False


def deliver_push(conn, user_id, title, body, task_id=None, kind=None, check_log=False, url='/'):
    if check_log:
        today = datetime.date.today().isoformat()
        exists = conn.execute(
            'SELECT 1 FROM push_log WHERE user_id = ? AND task_id = ? AND kind = ? AND sent_date = ?',
            (user_id, task_id or '', kind or '', today)
        ).fetchone()
        if exists:
            return 0
    mode = get_reminder_mode(conn, user_id)
    delivered = 0
    if mode != 'quiet':
        subs = conn.execute(
            'SELECT endpoint FROM push_subscriptions WHERE user_id = ?', (user_id,)
        ).fetchall()
        urgency = 'high' if mode == 'force' else 'low'
        for sub in subs:
            endpoint = sub['endpoint']
            if not VAPID_PUBLIC:
                continue
            try:
                token = vapid_jwt(endpoint)
                request = urllib.request.Request(
                    endpoint,
                    data=b'',
                    method='POST',
                    headers={
                        'Authorization': 'vapid t=' + token + ', k=' + VAPID_PUBLIC,
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': '0',
                        'TTL': '86400',
                        'Urgency': urgency,
                    }
                )
                with urllib.request.urlopen(request, timeout=10):
                    delivered += 1
            except Exception:
                pass
        if delivered:
            queue_message(conn, user_id, title, body, url)
    wechat_ok = send_pushplus(conn, user_id, title, body) if mode != 'quiet' else False
    email_ok = send_deadline_email(conn, user_id, title, body)
    total = delivered + (1 if wechat_ok else 0) + (1 if email_ok else 0)
    if total and check_log:
        with conn:
            conn.execute(
                'INSERT OR REPLACE INTO push_log (user_id, task_id, kind, sent_date) VALUES (?, ?, ?, ?)',
                (user_id, task_id or '', kind or '', datetime.date.today().isoformat())
            )
    return total


def deadline_message(title, left, task_time=None):
    if left == 0:
        if task_time:
            return '今天 ' + task_time + ' 这件事', '「' + title + '」定在今天 ' + task_time + '。到点前我还会提醒你一次。'
        return '今天，就这件事', '「' + title + '」今日到期。先动一动手，剩下的交给明天。'
    if left == 1:
        return '明天的事，今天先动', '「' + title + '」明天到期。不着急，但也别装忘。'
    if left == 2:
        return '后天这件，别忘了', '「' + title + '」后天到期。现在动一动，后天就轻松。'
    if left == 3:
        return '想跟你说一声', '「' + title + '」还有 3 天。不急，但也别装忘。'
    if left == 7:
        return '一周之后的事', '「' + title + '」还有一周。从容安排，时间绰绰有余。'
    return '这件事过去了', '「' + title + '」欠了 ' + str(-left) + ' 天。钱可以欠，事欠着心里不踏实。'


# 提前多久：按难度打底，再按重要度加权。重要的可以提前到 40 分钟甚至 1 小时
LEAD_BY_EFFORT = {1: 5, 2: 15, 3: 25, 4: 35, 5: 45}
LEAD_BONUS_QUAD = {9: 15, 8: 10, 7: 5, 6: 3}     # 重要度越高，越早提醒
# 两个提醒之间至少隔多久，避免连打（分）
MIN_GAP_MINUTES = 10
# 这个点之前不推，免得半夜吵人。早于这个点的任务，改在前一晚提醒
QUIET_END_HOUR = 6
EVENING_HOUR = 21


def human_left(mins):
    if mins >= 60:
        return str(mins // 60) + ' 小时' + (' ' + str(mins % 60) + ' 分钟' if mins % 60 else '')
    if mins > 0:
        return str(mins) + ' 分钟'
    return '几分钟'


def lead_for(task):
    """这条任务该提前多久提醒。难度打底，重要度加权。"""
    effort = 3
    quad = 5
    why = task.get('why')
    if isinstance(why, dict):
        try:
            effort = max(1, min(5, int(why.get('effort') or 3)))
        except (TypeError, ValueError):
            effort = 3
    try:
        quad = max(1, min(9, int(task.get('quadrant') or 5)))
    except (TypeError, ValueError):
        quad = 5
    lead = LEAD_BY_EFFORT.get(effort, 30) + LEAD_BONUS_QUAD.get(quad, 0)
    return min(lead, 60)    # 最多提前 1 小时，再早就是打扰了


def plan_notifications(tasks, now, already_sent_ids, days_ahead=1):
    """把带钟点、还没提醒过的任务排成一条时间线。
    支持今天和明天：早于 QUIET_END_HOUR 的，挪到前一晚 EVENING_HOUR 提醒
    ——早上六点才提醒六点的事，等于没提醒。
    返回按通知时刻升序排列的列表，相邻两条至少隔 MIN_GAP_MINUTES 分钟。
    """
    items = []
    for task in tasks:
        if not isinstance(task, dict) or task.get('status') == 'done':
            continue
        raw_time = str(task.get('time') or '').strip()
        dl = task.get('deadline')
        if not raw_time or not dl:
            continue
        try:
            due_date = datetime.date.fromisoformat(dl)
        except ValueError:
            continue
        gap_days = (due_date - now.date()).days
        if gap_days < 0 or gap_days > days_ahead:
            continue
        try:
            hh, mm = raw_time.split(':')
            due_dt = datetime.datetime.combine(due_date, datetime.time(int(hh), int(mm)))
        except (ValueError, TypeError):
            continue
        task_id = str(task.get('id', ''))
        if task_id in already_sent_ids:
            continue
        lead = lead_for(task)
        notify_at = due_dt - datetime.timedelta(minutes=lead)
        # 太早（深夜）就挪到前一晚，别在凌晨吵人
        if notify_at.hour < QUIET_END_HOUR:
            prev_evening = datetime.datetime.combine(
                due_date - datetime.timedelta(days=1),
                datetime.time(EVENING_HOUR, 0))
            notify_at = prev_evening
        # 提醒点已经过去、事情也过了的，不再排进时间线（补推没意义）
        if notify_at < now and due_dt < now:
            continue
        items.append({
            'task': task, 'task_id': task_id, 'due_dt': due_dt,
            'notify_at': notify_at, 'lead': lead, 'time': raw_time,
        })

    items.sort(key=lambda x: (x['notify_at'], x['due_dt']))
    last_at = None
    for it in items:
        if last_at is not None:
            earliest_ok = last_at + datetime.timedelta(minutes=MIN_GAP_MINUTES)
            if it['notify_at'] < earliest_ok:
                latest_ok = it['due_dt'] - datetime.timedelta(minutes=5)
                it['notify_at'] = min(earliest_ok, latest_ok) if latest_ok > last_at else latest_ok
        last_at = it['notify_at']
    return items


def push_worker():
    """每分钟扫一次。按规划好的时间线一条一条推，不打包、不连打。
    发送失败不记日志，下一分钟自动重试。
    """
    time.sleep(45)
    while True:
        try:
            now = datetime.datetime.now()
            today = now.date()
            with closing(connect()) as conn:
                users = conn.execute(
                    'SELECT user_id FROM push_subscriptions '
                    'UNION SELECT user_id FROM settings WHERE pushplus_token <> \'\' '
                ).fetchall()
                for row in users:
                    user_id = row['user_id']
                    state_row = conn.execute('SELECT data FROM states WHERE user_id = ?', (user_id,)).fetchone()
                    if not state_row:
                        continue
                    try:
                        state = json.loads(state_row['data'])
                    except (TypeError, ValueError):
                        continue

                    all_tasks = [t for t in state.get('tasks', []) if isinstance(t, dict)]
                    soon_tasks = []
                    for task in all_tasks:
                        dl = task.get('deadline')
                        if not dl:
                            continue
                        try:
                            gap = (datetime.date.fromisoformat(dl) - today).days
                        except ValueError:
                            continue
                        if 0 <= gap <= 1:      # 今天和明天，明天的是为了"前一晚提醒"
                            soon_tasks.append(task)

                    # ---- 1. 带钟点的任务：按时间线推，一次一条 ----
                    sent_rows = conn.execute(
                        "SELECT task_id, kind FROM push_log WHERE user_id = ? AND sent_date = ?",
                        (user_id, today.isoformat())
                    ).fetchall()
                    sent_ids = set(str(r['task_id']) for r in sent_rows if str(r['kind']).startswith('t'))

                    if now.hour >= QUIET_END_HOUR:
                        timeline = plan_notifications(today_tasks, now, sent_ids)
                        for it in timeline:
                            if it['notify_at'] > now:
                                break            # 还没到点，后面的更晚
                            mins = int((it['due_dt'] - now).total_seconds() // 60)
                            if mins < 0:
                                continue         # 这个点已经过了，不补推
                            # 只有"前一晚提醒"才允许在晚间发；当天任务仍按 QUIET_END_HOUR 起
                            if it['notify_at'].date() < it['due_dt'].date():
                                if now.hour < EVENING_HOUR:
                                    continue
                            task = it['task']
                            effort = 3
                            why = task.get('why')
                            if isinstance(why, dict):
                                try:
                                    effort = max(1, min(5, int(why.get('effort') or 3)))
                                except (TypeError, ValueError):
                                    effort = 3
                            left_txt = human_left(mins)
                            if effort >= 4:
                                tail = '这活儿费神，手头别的先放一放。'
                            elif effort <= 2:
                                tail = '顺手的事，到点做掉就完了。'
                            else:
                                tail = '该动手了，别拖到最后一分钟。'
                            deliver_push(
                                conn, user_id,
                                it['time'] + ' 还有 ' + left_txt,
                                '「' + str(task.get('title', '未命名任务')) + '」。' + tail,
                                task_id=it['task_id'], kind='t' + it['time'], check_log=True
                            )
                            break                # 这一分钟只推一条，下一条下一分钟推

                    # ---- 2. 按天的到期提醒 ----
                    for task in all_tasks:
                        dl = task.get('deadline')
                        if not dl:
                            continue
                        try:
                            due = datetime.date.fromisoformat(dl)
                        except ValueError:
                            continue
                        left = (due - today).days
                        if left not in (0, 1, 2, 3, 7, -1, -3):
                            continue
                        # 第 2 天只在"要紧的事"才打扰，免得噪音
                        if left == 2:
                            try:
                                qv = int(task.get('quadrant') or 5)
                            except (TypeError, ValueError):
                                qv = 5
                            if qv < 8:
                                continue
                        head, text = deadline_message(
                            str(task.get('title', '未命名任务')), left, task.get('time') or None)
                        deliver_push(
                            conn, user_id, head, text,
                            task_id=str(task.get('id', '')), kind='d' + str(left), check_log=True
                        )
        except Exception:
            pass
        time.sleep(60)


def hourly_backup_worker():
    """每小时备一份。只在启动时备份远远不够——服务不重启就永远只有启动那天的库。
    同一小时内重复调用不会重复写，backup_db 自己判断文件是否已存在。"""
    while True:
        try:
            backup_db()
        except Exception:
            pass
        time.sleep(3600)


def hash_password(password, salt_bytes):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt_bytes, PBKDF2_ROUNDS).hex()


def session_user(handler, conn):
    token = None
    for part in handler.headers.get('Cookie', '').split(';'):
        key, _, value = part.strip().partition('=')
        if key == COOKIE:
            token = value
            break
    if not token:
        return None
    return conn.execute(
        'SELECT u.id AS id, u.username AS username, u.is_admin AS is_admin, u.email AS email '
        'FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', (token,)
    ).fetchone()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def _json(self, code, payload, set_cookie=None):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if set_cookie:
            self.send_header('Set-Cookie', set_cookie)
        self.end_headers()
        self.wfile.write(body)

    def _cookie(self, token, delete=False):
        if delete:
            return COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
        return COOKIE + '=' + token + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax'

    def _body(self):
        length = int(self.headers.get('Content-Length') or '0')
        if length <= 0 or length > MAX_BODY:
            raise ValueError('invalid body size')
        data = json.loads(self.rfile.read(length).decode('utf-8'))
        if not isinstance(data, dict):
            raise ValueError('body must be object')
        return data

    def _static(self, path):
        entry = STATIC.get(path)
        if not entry:
            self._json(404, {'error': 'not found'})
            return
        filename, content_type = entry
        try:
            with open(os.path.join(ROOT, filename), 'rb') as f:
                body = f.read()
        except OSError:
            self._json(404, {'error': 'not found'})
            return
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in STATIC:
            self._static(path)
            return
        with closing(connect()) as conn:
            if path == '/api/me':
                user = session_user(self, conn)
                self._json(200, {
                    'authenticated': bool(user),
                    'username': user['username'] if user else None,
                    'isAdmin': bool(user['is_admin']) if user else False,
                    'email': user['email'] if user else None
                })
                return
            if path == '/api/push/key':
                self._json(200, {'enabled': bool(VAPID_PUBLIC), 'publicKey': VAPID_PUBLIC})
                return
            if path == '/api/auth/config':
                self._json(200, {
                    'emailRequired': True,
                    # 注册不再要邮箱验证码；这个字段只影响前端要不要显示验证码输入框
                    'emailVerified': False
                })
                return
            if path == '/api/admin/smtp':
                user = session_user(self, conn)
                if not user:
                    self._json(401, {'error': '请先登录'})
                    return
                if not user['is_admin']:
                    self._json(403, {'error': '只有管理员能设置邮件服务'})
                    return
                cfg = smtp_config(conn)
                self._json(200, {
                    'configured': smtp_ready(cfg),
                    'host': cfg['host'], 'port': cfg['port'],
                    'user': cfg['user'], 'sender': cfg['sender']
                })
                return
            if path == '/api/admin/export-all':
                # 管理员全量导出：给备份用。故意不含密码哈希与盐。
                # 恢复时账号还在、数据还在，密码让用户走「找回密码」重设。
                user = session_user(self, conn)
                if not user:
                    self._json(401, {'error': '请先登录'})
                    return
                if not user['is_admin']:
                    self._json(403, {'error': '只有管理员能导出全部数据'})
                    return
                rows = conn.execute(
                    'SELECT u.id AS id, u.username AS username, u.email AS email, '
                    'u.is_admin AS is_admin, u.created_at AS created_at, s.data AS data '
                    'FROM users u LEFT JOIN states s ON s.user_id = u.id ORDER BY u.id'
                ).fetchall()
                users = []
                for r in rows:
                    state = None
                    if r['data']:
                        try:
                            state = json.loads(r['data'])
                        except (TypeError, ValueError):
                            state = None
                    users.append({
                        'id': r['id'],
                        'username': r['username'],
                        'email': r['email'],
                        'isAdmin': bool(r['is_admin']),
                        'createdAt': r['created_at'],
                        'state': state,
                    })
                self._json(200, {
                    'exportedAt': datetime.datetime.now().isoformat(timespec='seconds'),
                    'userCount': len(users),
                    'passwordHashIncluded': False,
                    'users': users,
                })
                return
            if path == '/api/reminder/mode':
                user = session_user(self, conn)
                if not user:
                    self._json(401, {'error': '请先登录'})
                    return
                self._json(200, {'mode': get_reminder_mode(conn, user['id'])})
                return
            if path == '/api/pushplus/status':
                user = session_user(self, conn)
                if not user:
                    self._json(401, {'error': '请先登录'})
                    return
                token, channel = get_pushplus_config(conn, user['id'])
                self._json(200, {'configured': bool(token), 'channel': channel})
                return
            if path == '/api/state':
                user = session_user(self, conn)
                if not user:
                    self._json(401, {'error': '请先登录'})
                    return
                row = conn.execute('SELECT data FROM states WHERE user_id = ?', (user['id'],)).fetchone()
                state = json.loads(row['data']) if row else None
                self._json(200, {'state': state})
                return
            if path == '/api/push/messages':
                user = session_user(self, conn)
                if not user:
                    self._json(401, {'error': '请先登录'})
                    return
                rows = conn.execute(
                    'SELECT id, title, body, url FROM push_messages WHERE user_id = ? ORDER BY id',
                    (user['id'],)
                ).fetchall()
                items = [{'title': r['title'], 'body': r['body'], 'url': r['url']} for r in rows]
                if rows:
                    with conn:
                        conn.execute('DELETE FROM push_messages WHERE user_id = ?', (user['id'],))
                self._json(200, items)
                return
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        allowed = ('/api/register', '/api/login', '/api/logout', '/api/state',
                   '/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test',
                   '/api/pushplus/config', '/api/pushplus/test',
                   '/api/email/send-code', '/api/admin/smtp', '/api/admin/smtp/test',
                   '/api/password/reset', '/api/email/notify', '/api/email/notify/test',
                   '/api/reminder/mode')
        if path not in allowed:
            self._json(404, {'error': 'not found'})
            return
        try:
            body = self._body() if path not in ('/api/logout', '/api/push/test', '/api/pushplus/test', '/api/admin/smtp/test', '/api/email/notify/test') else {}
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {'error': '请求格式错误'})
            return

        with closing(connect()) as conn:
            if path == '/api/email/send-code':
                email = str(body.get('email', '')).strip().lower()
                purpose = 'reset' if body.get('purpose') == 'reset' else 'register'
                if not is_valid_email(email):
                    self._json(400, {'error': '邮箱格式不对'})
                    return
                if not smtp_ready(smtp_config(conn)):
                    self._json(400, {'error': '管理员还没配置邮件服务，暂时发不了验证码'})
                    return
                exists = conn.execute('SELECT 1 FROM users WHERE email = ?', (email,)).fetchone()
                if purpose == 'register' and exists:
                    self._json(409, {'error': '这个邮箱已经注册过了，直接登录或用另一个邮箱'})
                    return
                if purpose == 'reset' and not exists:
                    self._json(404, {'error': '这个邮箱没有注册过账号'})
                    return
                last = conn.execute(
                    'SELECT created_at FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
                    (email, purpose)
                ).fetchone()
                if last and int(time.time()) - last['created_at'] < 60:
                    self._json(429, {'error': '刚发过验证码，60 秒后再试'})
                    return
                code = create_email_code(conn, email, purpose)
                subject = '每日四象限 · 重置密码验证码' if purpose == 'reset' else '每日四象限 · 邮箱验证码'
                body_text = ('你在重置密码。验证码是：' + code +
                             '\n\n10 分钟内有效。如果不是你本人操作，请忽略这封邮件。') if purpose == 'reset' else (
                             '你的验证码是：' + code + '\n\n10 分钟内有效。如果不是你在注册，请忽略这封邮件。')
                try:
                    send_email(smtp_config(conn), email, subject, body_text)
                except Exception as exc:
                    self._json(502, {'error': '验证码发送失败：' + str(exc)[:120]})
                    return
                self._json(200, {'ok': True, 'message': '验证码已发送，10 分钟内有效'})
                return

            if path == '/api/password/reset':
                email = str(body.get('email', '')).strip().lower()
                code = str(body.get('code', '')).strip()
                new_password = str(body.get('password', ''))
                if len(new_password) < 6 or len(new_password) > 128:
                    self._json(400, {'error': '新密码至少 6 位'})
                    return
                if not verify_email_code(conn, email, code, 'reset'):
                    self._json(400, {'error': '验证码不对或已过期，请重新获取'})
                    return
                row = conn.execute('SELECT id FROM users WHERE email = ?', (email,)).fetchone()
                if not row:
                    self._json(404, {'error': '这个邮箱没有注册过账号'})
                    return
                salt = secrets.token_bytes(16)
                with conn:
                    conn.execute('UPDATE users SET salt = ?, pass_hash = ? WHERE id = ?',
                                 (salt.hex(), hash_password(new_password, salt), row['id']))
                self._json(200, {'ok': True, 'message': '密码已重置，请用新密码登录'})
                return

            if path == '/api/register':
                username = str(body.get('username', '')).strip()
                password = str(body.get('password', ''))
                email = str(body.get('email', '')).strip().lower()
                code = str(body.get('code', '')).strip()
                if len(username) < 2 or len(username) > 32:
                    self._json(400, {'error': '账号长度需为 2-32 个字符'})
                    return
                if len(password) < 6 or len(password) > 128:
                    self._json(400, {'error': '密码至少 6 位'})
                    return
                if not is_valid_email(email):
                    self._json(400, {'error': '请填写有效的邮箱——它是找回账号的唯一方式'})
                    return
                # 注册不卡邮箱验证码：发信受额度、垃圾箱影响，卡在这里等于把人挡在门外。
                # 邮箱只用于「找回密码」，发不出去也能正常注册。
                if conn.execute('SELECT 1 FROM users WHERE email = ?', (email,)).fetchone():
                    self._json(409, {'error': '这个邮箱已经注册过了，直接登录或用另一个邮箱'})
                    return
                if conn.execute('SELECT 1 FROM users WHERE username = ?', (username,)).fetchone():
                    self._json(409, {'error': '这个账号名被占了，换一个'})
                    return
                salt = secrets.token_bytes(16)
                is_first = not conn.execute('SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1').fetchone()
                try:
                    with conn:
                        cur = conn.execute(
                            'INSERT INTO users (username, salt, pass_hash, email, is_admin) VALUES (?, ?, ?, ?, ?)',
                            (username, salt.hex(), hash_password(password, salt), email, 1 if is_first else 0)
                        )
                        user_id = cur.lastrowid
                except sqlite3.IntegrityError:
                    self._json(409, {'error': '账号或邮箱已被占用'})
                    return
                token = secrets.token_urlsafe(32)
                with conn:
                    conn.execute('INSERT INTO sessions (token, user_id) VALUES (?, ?)', (token, user_id))
                    conn.execute('INSERT OR IGNORE INTO states (user_id, data) VALUES (?, ?)',
                                 (user_id, json.dumps({'version': 1, 'tasks': []})))
                self._json(200, {'ok': True, 'username': username, 'isAdmin': is_first}, self._cookie(token))
                return

            if path == '/api/login':
                username = str(body.get('username', '')).strip()
                password = str(body.get('password', ''))
                row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
                if not row:
                    self._json(401, {'error': '账号或密码错误'})
                    return
                salt = bytes.fromhex(row['salt'])
                supplied = hash_password(password, salt)
                if not hmac.compare_digest(supplied, row['pass_hash']):
                    self._json(401, {'error': '账号或密码错误'})
                    return
                token = secrets.token_urlsafe(32)
                with conn:
                    conn.execute('INSERT INTO sessions (token, user_id) VALUES (?, ?)', (token, row['id']))
                self._json(200, {'ok': True, 'username': row['username'],
                                 'isAdmin': bool(row['is_admin'])}, self._cookie(token))
                return

            user = session_user(self, conn)
            if not user:
                self._json(401, {'error': '请先登录'})
                return

            if path == '/api/admin/smtp':
                if not user['is_admin']:
                    self._json(403, {'error': '只有管理员能设置邮件服务'})
                    return
                host = str(body.get('host', '')).strip()
                port = str(body.get('port', '465')).strip()
                smtp_user = str(body.get('user', '')).strip()
                password = str(body.get('password', '')).strip()
                sender = str(body.get('sender', '')).strip()
                if not host or not smtp_user:
                    self._json(400, {'error': 'SMTP 地址和邮箱账号都要填'})
                    return
                if not re.match(r'^\d+$', port):
                    self._json(400, {'error': '端口只能是数字'})
                    return
                cfg = {'host': host, 'port': port, 'user': smtp_user,
                       'password': password, 'sender': sender}
                if not password:
                    cfg['password'] = get_server_setting(conn, 'smtp_password', '')
                test_to = smtp_user
                try:
                    send_email(cfg, test_to, '每日四象限 · 邮件服务已配置',
                               '你收到这封邮件，说明发信设置正确。现在可以开启邮箱验证了。')
                except Exception as exc:
                    detail = str(exc)[:140]
                    hint = ('。授权码错误或该邮箱不支持密码发信' if
                            ('535' in detail or 'auth' in detail.lower() or 'password' in detail.lower())
                            else '。检查 SMTP 地址和端口是否正确')
                    self._json(400, {'error': '发信测试失败：' + detail + hint})
                    return
                for key, val in (('smtp_host', host), ('smtp_port', port),
                                 ('smtp_user', smtp_user), ('smtp_password', cfg['password']),
                                 ('smtp_sender', sender)):
                    set_server_setting(conn, key, val)
                self._json(200, {'ok': True, 'message': '配置成功，测试邮件已发到 ' + test_to})
                return

            if path == '/api/admin/smtp/test':
                if not user['is_admin']:
                    self._json(403, {'error': '只有管理员能设置邮件服务'})
                    return
                cfg = smtp_config(conn)
                if not smtp_ready(cfg):
                    self._json(400, {'error': '还没配置邮件服务'})
                    return
                try:
                    send_email(cfg, cfg['user'], '每日四象限 · 测试邮件',
                               '如果你看到这封邮件，说明发信正常。')
                except Exception as exc:
                    self._json(502, {'error': '发送失败：' + str(exc)[:140]})
                    return
                self._json(200, {'ok': True, 'message': '测试邮件已发送'})
                return

            if path == '/api/logout':
                token = None
                for part in self.headers.get('Cookie', '').split(';'):
                    key, _, value = part.strip().partition('=')
                    if key == COOKIE:
                        token = value
                        break
                if token:
                    with conn:
                        conn.execute('DELETE FROM sessions WHERE token = ?', (token,))
                self._json(200, {'ok': True}, self._cookie('', delete=True))
                return

            if path == '/api/state':
                state = body.get('state')
                if not isinstance(state, dict) or not isinstance(state.get('tasks'), list):
                    self._json(400, {'error': '数据格式错误'})
                    return
                try:
                    payload = json.dumps(state, ensure_ascii=False)
                except (TypeError, ValueError):
                    self._json(400, {'error': '数据无法序列化'})
                    return
                with conn:
                    conn.execute(
                        'INSERT INTO states (user_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) '
                        'ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP',
                        (user['id'], payload)
                    )
                self._json(200, {'ok': True})
                return

            if path == '/api/push/subscribe':
                sub = body.get('subscription')
                if not isinstance(sub, dict) or not sub.get('endpoint'):
                    self._json(400, {'error': '订阅数据错误'})
                    return
                with conn:
                    conn.execute(
                        'INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)',
                        (user['id'], str(sub['endpoint'])[:1000], '', '')
                    )
                self._json(200, {'ok': True})
                return

            if path == '/api/push/unsubscribe':
                endpoint = str(body.get('endpoint') or '')
                with conn:
                    conn.execute('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?',
                                 (user['id'], endpoint))
                self._json(200, {'ok': True})
                return

            if path == '/api/push/test':
                delivered = deliver_push(
                    conn, user['id'],
                    '四象限 · 推送测试',
                    '如果你看到这条通知，说明这台设备可以收到主动提醒。'
                )
                self._json(200, {
                    'ok': True,
                    'sent': delivered,
                    'message': '已发送' if delivered else '没有可用订阅，或推送服务不可达'
                })
                return

            if path == '/api/email/notify/test':
                cfg = smtp_config(conn)
                if not smtp_ready(cfg):
                    self._json(400, {'error': '管理员还没配置邮件服务'})
                    return
                row = conn.execute('SELECT email FROM users WHERE id = ?', (user['id'],)).fetchone()
                if not row or not row['email']:
                    self._json(400, {'error': '账号没绑邮箱'})
                    return
                try:
                    send_email(cfg, row['email'], '每日四象限 · 提醒测试',
                               '如果你看到这封邮件，说明邮件提醒已经通了。')
                except Exception as exc:
                    self._json(502, {'error': '发送失败：' + str(exc)[:140]})
                    return
                self._json(200, {'ok': True, 'message': '测试邮件已发到你的邮箱'})
                return

            if path == '/api/reminder/mode':
                mode = str(body.get('mode', '')).strip()
                if mode not in ('quiet', 'normal', 'force'):
                    self._json(400, {'error': '提醒强度只能是 quiet / normal / force'})
                    return
                with conn:
                    conn.execute(
                        'INSERT INTO settings (user_id, reminder_mode) VALUES (?, ?) '
                        'ON CONFLICT(user_id) DO UPDATE SET reminder_mode = excluded.reminder_mode',
                        (user['id'], mode)
                    )
                self._json(200, {'ok': True, 'mode': mode})
                return

            if path == '/api/email/notify':
                enabled = 1 if body.get('enabled') else 0
                with conn:
                    conn.execute(
                        'INSERT INTO settings (user_id, email_notify) VALUES (?, ?) '
                        'ON CONFLICT(user_id) DO UPDATE SET email_notify = excluded.email_notify',
                        (user['id'], enabled)
                    )
                self._json(200, {'ok': True, 'enabled': bool(enabled)})
                return

            if path == '/api/pushplus/config':
                token = str(body.get('token') or '').strip()
                channel = str(body.get('channel') or 'wechat')
                if channel not in PUSHPLUS_CHANNELS:
                    self._json(400, {'error': '不支持的渠道'})
                    return
                if token and len(token) > 200:
                    self._json(400, {'error': 'token 长度异常'})
                    return
                with conn:
                    conn.execute(
                        'INSERT INTO settings (user_id, pushplus_token, pushplus_channel) VALUES (?, ?, ?) '
                        'ON CONFLICT(user_id) DO UPDATE SET pushplus_token = excluded.pushplus_token, '
                        'pushplus_channel = excluded.pushplus_channel',
                        (user['id'], token, channel)
                    )
                self._json(200, {'ok': True, 'configured': bool(token)})
                return

            if path == '/api/pushplus/test':
                token, channel = get_pushplus_config(conn, user['id'])
                if not token:
                    self._json(400, {'error': '请先保存 pushplus token'})
                    return
                ok = send_pushplus(
                    conn, user['id'],
                    '四象限 · 微信提醒测试',
                    '如果你在微信里看到这条消息，说明微信提醒已经接通。'
                )
                self._json(200, {'ok': True, 'sent': ok,
                                 'message': '请求已提交，请查看微信' if ok else '请求失败，检查 token 或网络'})
                return


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    migrate_legacy_db()
    init_db()
    backup_db()
    threading.Thread(target=push_worker, daemon=True).start()
    threading.Thread(target=hourly_backup_worker, daemon=True).start()
    print('daily-quadrant listening on 0.0.0.0:' + str(PORT) +
          ' (webpush=' + str(bool(VAPID_PUBLIC)) + ', pushplus=' + str(bool(PUSHPLUS_API)) + ')', flush=True)
    Server(('0.0.0.0', PORT), Handler).serve_forever()
