#!/usr/bin/env python3
# 本机启动器：读 credentials.local.json，用 Paramiko 跑服务器上的只读玩家/库存脚本。
# 用法：python server/deploy/admin-players.py --all
import json
import os
import shlex
import sys

try:
    import paramiko
except ImportError:
    print('需要 paramiko：python -m pip install paramiko', file=sys.stderr)
    raise SystemExit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
CRED_FILE = os.path.join(HERE, 'credentials.local.json')
if not os.path.exists(CRED_FILE):
    print('找不到 ' + CRED_FILE, file=sys.stderr)
    raise SystemExit(1)

cred = json.load(open(CRED_FILE, encoding='utf-8'))
remote_args = ' '.join(shlex.quote(arg) for arg in sys.argv[1:])
remote_cmd = ('sudo -u ssdz env NODE_NO_WARNINGS=1 /opt/node22/bin/node /opt/ssdz/server/admin-players.js ' + remote_args).strip()

try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    client.connect(
        cred['host'], port=int(cred.get('port') or 22), username=cred['user'],
        password=cred['password'], timeout=20, banner_timeout=20, auth_timeout=20,
    )
    stdin, stdout, stderr = client.exec_command(remote_cmd, timeout=300)
    out = stdout.read().decode('utf-8', 'replace')
    err = stderr.read().decode('utf-8', 'replace')
    code = stdout.channel.recv_exit_status()
    sys.stdout.write(out)
    if err:
        sys.stderr.write(err)
    raise SystemExit(code)
except paramiko.AuthenticationException:
    print('SSH 认证失败：检查 server/deploy/credentials.local.json 里的密码', file=sys.stderr)
    raise SystemExit(2)
except Exception as exc:
    print('连接/执行失败：' + str(exc), file=sys.stderr)
    raise SystemExit(1)
finally:
    client.close()
