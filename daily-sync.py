"""每天把线上全部数据拉一份，推到私有仓库 daily-quadrant-data。

这是「改代码永远不怕丢数据」的那一层：数据不再只活在服务容器里，
异地（GitHub 私有仓库）永远有一份最近的。

凭据从环境变量读，不写进任何文件：
    DQ_USER=管理员账号
    DQ_PASS=密码
    DQ_BASE=线上地址（可选）
    DQ_SHARECODE=分享码（可选）

用法：
    python daily-sync.py
    python daily-sync.py --dry-run     # 只拉不推
"""

import datetime
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(os.path.dirname(HERE), 'dq-backup')
DATA_DIR = os.path.join(REPO, 'data')
KEEP = 120          # 每 2 小时一份，120 份约 10 天


def load_env_file():
    """账号密码优先读环境变量，其次读项目里的 .env（已在 .gitignore 里）。"""
    path = os.path.join(HERE, '.env')
    if not os.path.isfile(path):
        return
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


def sh(cmd, cwd=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def main():
    dry = '--dry-run' in sys.argv
    load_env_file()
    user = os.environ.get('DQ_USER', '').strip()
    pwd = os.environ.get('DQ_PASS', '')
    if not user or not pwd:
        print('缺 DQ_USER / DQ_PASS。在 daily-quadrant 目录建一个 .env 文件，写两行：')
        print('  DQ_USER=你的管理员账号')
        print('  DQ_PASS=你的密码')
        print('（.env 已在 .gitignore 里，不会被提交）')
        return 2

    # 复用 snapshot.py 的导出逻辑
    sys.argv = ['snapshot.py', user, pwd]
    sys.path.insert(0, HERE)
    import snapshot  # noqa: E402
    rc = snapshot.main()
    if rc != 0:
        return rc

    files = sorted(f for f in os.listdir(os.path.join(HERE, 'backups')) if f.startswith('snapshot-'))
    if not files:
        print('没找到快照文件')
        return 1
    latest = files[-1]
    src = os.path.join(HERE, 'backups', latest)

    os.makedirs(DATA_DIR, exist_ok=True)
    stamp = datetime.datetime.now().strftime('%Y-%m-%d-%H%M')
    dest = os.path.join(DATA_DIR, 'snapshot-%s.json' % stamp)
    shutil.copyfile(src, dest)
    print('写入仓库:', dest)

    olds = sorted(f for f in os.listdir(DATA_DIR) if f.startswith('snapshot-'))
    for f in olds[:-KEEP]:
        os.remove(os.path.join(DATA_DIR, f))

    if dry:
        print('--dry-run，不提交')
        return 0

    if not os.path.isdir(os.path.join(REPO, '.git')):
        print('dq-backup 不是 git 仓库，跳过推送')
        return 1

    sh(['git', 'add', '-A'], REPO)
    code, out = sh(['git', '-c', 'user.name=dasein-chao',
                    '-c', 'user.email=dasein-chao@users.noreply.github.com',
                    'commit', '-m', '数据快照 %s' % stamp], REPO)
    if code != 0 and 'nothing to commit' not in out:
        print(out.strip())
    code, out = sh(['git', 'push', '-q', 'origin', 'main'], REPO)
    if code != 0:
        print('推送失败:', out.strip())
        return 1
    print('已推到 GitHub（私有仓库）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
