"""把快照写回线上。

用于「发布把线上数据覆盖了/容器丢了」之后恢复。优先恢复全量快照
（/api/admin/export-all 的产物），普通账号导出的单用户快照只能恢复自己。

用法：
    python restore.py <管理员用户名> <密码> backups/snapshot-all-users-xxx.json

注意：
- 同账号已存在 → 用快照里的任务覆盖它现在的任务（这就是恢复）
- 账号不存在 → 新建，密码是随机的，本人要用「找回密码」重设
- 不会动密码哈希，也不会把普通用户变成管理员
"""

import json
import os
import sys
import http.cookiejar
import urllib.request

BASE = os.environ.get('DQ_BASE', 'https://daily-quadrant-32717.app.workbuddy.host')
SHARECODE = os.environ.get('DQ_SHARECODE', 'SI4C4EK6BF')


def opener():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(op, path, payload=None):
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={'Content-Type': 'application/json'},
                                 method='POST' if data else 'GET')
    with op.open(req, timeout=30) as r:
        body = r.read().decode('utf-8')
    return json.loads(body) if body else {}


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    user, pwd, dump_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(dump_path, encoding='utf-8') as f:
        dump = json.load(f)

    users = dump.get('users')
    if not users and dump.get('state') is not None:
        users = [{'username': dump.get('username') or user, 'state': dump['state']}]
    if not users:
        print('这份文件里没有 users，也不是单用户快照，没法恢复。')
        return 1

    op = opener()
    op.open(BASE + '/?sharecode=' + SHARECODE, timeout=20).read()
    res = call(op, '/api/login', {'username': user, 'password': pwd})
    if not res.get('ok'):
        print('登录失败:', res.get('error') or res)
        return 1
    if not res.get('isAdmin'):
        print('这个账号不是管理员，无法恢复全部用户。')
        return 1

    print('准备恢复 %d 个用户（来自 %s）' % (len(users), dump_path))
    out = call(op, '/api/admin/import-all', {'users': users, 'confirm': True})
    print('结果:', out)
    print('核对:', call(op, '/api/health'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
