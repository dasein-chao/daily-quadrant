"""发布前后一键核对：本地有没有没推的东西、远程是不是真收到、线上跑的是哪一版。

用法：
  python sync-check.py            只检查
  python sync-check.py --push     先推，再检查

退出码 0 = 三项全对齐；1 = 有问题，文字里会说清是哪一项。
"""

import io
import os
import re
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.environ.get('DQ_BASE', 'https://daily-quadrant-32717.app.workbuddy.host')
SHARE = os.environ.get('DQ_SHARECODE', 'SI4C4EK6BF')
BRANCH = 'main'


def git(*args):
    p = subprocess.run(['git'] + list(args), cwd=HERE,
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    return p.returncode, (p.stdout or '').strip(), (p.stderr or '').strip()


def local_head():
    code, out, err = git('rev-parse', 'HEAD')
    return out if code == 0 else ''


def remote_head():
    code, out, err = git('ls-remote', 'origin', 'refs/heads/' + BRANCH)
    if code != 0:
        return '', err
    return (out.split()[0] if out else ''), ''


def local_version():
    p = os.path.join(HERE, 'index.html')
    s = io.open(p, encoding='utf-8').read()
    m = re.search(r'app\.js\?v=(\d+)', s)
    return m.group(1) if m else '?'


def live_version():
    url = BASE + '/?sharecode=' + SHARE
    req = urllib.request.Request(url, headers={'User-Agent': 'sync-check'})
    with urllib.request.urlopen(req, timeout=20) as r:
        html = r.read().decode('utf-8', 'replace')
    m = re.search(r'app\.js\?v=(\d+)', html)
    return m.group(1) if m else '?'


def main():
    if '--push' in sys.argv:
        code, out, err = git('push', '-q', 'origin', BRANCH)
        print('推送：' + ('成功' if code == 0 else '失败 ' + err))
        if code != 0:
            return 1

    problems = []

    code, dirty, err = git('status', '--porcelain')
    if code != 0:
        print('不是 git 仓库，或 git 不可用：' + err)
        return 1
    if dirty:
        problems.append('工作区有 %d 处没提交的改动' % len(dirty.splitlines()))
        print('未提交的文件：')
        for line in dirty.splitlines()[:12]:
            print('  ' + line)

    lh = local_head()
    rh, rerr = remote_head()
    print('本地 HEAD：' + (lh[:8] or '(无)'))
    print('远程 HEAD：' + (rh[:8] or '(读不到)'))
    if not lh or not rh:
        problems.append('读不到提交号' + ('：' + rerr if rerr else ''))
    elif lh != rh:
        problems.append('本地和远程不一致，代码只在你这台机器上')

    lv = local_version()
    try:
        vv = live_version()
    except Exception as e:
        vv = '读不到'
        problems.append('线上打不开：%s' % e)
    print('本地版本：v%s ｜ 线上版本：%s' % (lv, ('v' + vv) if vv.isdigit() else vv))
    if vv.isdigit() and lv.isdigit() and lv != vv:
        problems.append('线上跑的不是本地这一版（本地 v%s，线上 v%s）' % (lv, vv))

    print('-' * 40)
    if problems:
        print('没对齐：')
        for p in problems:
            print('  · ' + p)
        return 1
    print('三项都对上了：工作区干净、远程已收到、线上就是这一版。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
