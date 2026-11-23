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
import re
from email.mime.text import MIMEText
from email.utils import formataddr
from contextlib import closing

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT, 'data.db')
VAPID_PRIVATE_PATH = os.path.join(ROOT, 'vapid_private.pem')
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


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with closing(connect()) as conn:
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
                FOREIGN KEY(user_id) REFERENCES users(id)
            )''')
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
            # 开发期测试账号不得占据管理员位
            test_names = ('live_test', 'tester_a', 'tester_b', 'pushuser', 'wxuser',
                          'newui', 'checksuser', 'admin1', 'newuser', 'owner_check')
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
    sender = cfg['sender'] or cfg['user']
    msg['From'] = formataddr(('每日四象限', sender))
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


def deliver_push(conn, user_id, title, body, task_id=None, kind=None, check_log=False, url='/'):
    if check_log:
        today = datetime.date.today().isoformat()
        exists = conn.execute(
            'SELECT 1 FROM push_log WHERE user_id = ? AND task_id = ? AND kind = ? AND sent_date = ?',
            (user_id, task_id or '', kind or '', today)
        ).fetchone()
        if exists:
            return 0
    delivered = 0
    subs = conn.execute(
        'SELECT endpoint FROM push_subscriptions WHERE user_id = ?', (user_id,)
    ).fetchall()
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
                }
            )
            with urllib.request.urlopen(request, timeout=10):
                delivered += 1
        except Exception:
            pass
    if delivered:
        queue_message(conn, user_id, title, body, url)
    wechat_ok = send_pushplus(conn, user_id, title, body)
    total = delivered + (1 if wechat_ok else 0)
    if total and check_log:
        with conn:
            conn.execute(
                'INSERT OR REPLACE INTO push_log (user_id, task_id, kind, sent_date) VALUES (?, ?, ?, ?)',
                (user_id, task_id or '', kind or '', datetime.date.today().isoformat())
            )
    return total


def deadline_message(title, left):
    if left == 0:
        return '今天，就这件事', '「' + title + '」今天到期。花十分钟先推一下，晚上就踏实了。'
    if left == 1:
        return '明天的事，今天先动', '「' + title + '」明天到期。今天做一点，明天就不慌。'
    if left == 3:
        return '想跟你说一声', '「' + title + '」还有 3 天。不着急，但也别忘。'
    if left == 7:
        return '一周之后的事', '「' + title + '」还有一周。现在安排，时间绰绰有余。'
    return '这件事过去了', '「' + title + '」已经过去 ' + str(-left) + ' 天了。要么今天做，要么跟我说改到哪天。'


def push_worker():
    time.sleep(45)
    while True:
        try:
            today = datetime.date.today()
            with closing(connect()) as conn:
                users = conn.execute(
                    'SELECT user_id FROM push_subscriptions '
                    'UNION SELECT user_id FROM settings WHERE pushplus_token <> \'\''
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
                    for task in state.get('tasks', []):
                        if not isinstance(task, dict) or task.get('status') == 'done':
                            continue
                        deadline = task.get('deadline')
                        if not deadline:
                            continue
                        try:
                            due = datetime.date.fromisoformat(deadline)
                        except ValueError:
                            continue
                        left = (due - today).days
                        if left not in (0, 1, 3, 7, -1, -3):
                            continue
                        head, text = deadline_message(str(task.get('title', '未命名任务')), left)
                        deliver_push(
                            conn, user_id, head, text,
                            task_id=str(task.get('id', '')),
                            kind='d' + str(left),
                            check_log=True
                        )
        except Exception:
            pass
        time.sleep(600)


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
                    'emailVerified': smtp_ready(smtp_config(conn))
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
                   '/api/password/reset')
        if path not in allowed:
            self._json(404, {'error': 'not found'})
            return
        try:
            body = self._body() if path not in ('/api/logout', '/api/push/test', '/api/pushplus/test', '/api/admin/smtp/test') else {}
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
                    'SELECT created_at FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1', (email,)
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
                cfg = smtp_config(conn)
                if smtp_ready(cfg) and not verify_email_code(conn, email, code, 'register'):
                    self._json(400, {'error': '验证码不对或已过期，请重新获取'})
                    return
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
                    self._json(400, {'error': '发信测试失败：' + str(exc)[:140] + '。请检查授权码。'})
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
    init_db()
    threading.Thread(target=push_worker, daemon=True).start()
    print('daily-quadrant listening on 0.0.0.0:' + str(PORT) +
          ' (webpush=' + str(bool(VAPID_PUBLIC)) + ', pushplus=' + str(bool(PUSHPLUS_API)) + ')', flush=True)
    Server(('0.0.0.0', PORT), Handler).serve_forever()
